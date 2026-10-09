// Integration checks: 30 synthetic analysed games through the whole pipeline -- profile,
// drill deck, plan, .ics, spaced repetition and the coach's summary. Modules load in
// browser order with a fake global root. Run: node test/integration.js
globalThis.window = globalThis;
require('../js/core.js'); require('../js/engine.js'); require('../js/data.js');
require('../js/analysis.js'); require('../js/training.js'); require('../js/coach.js');
require('../js/sparring.js');
const { Chess, Engine, Analysis, Training, Coach, Sparring, Data } = globalThis;

let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}

// ---- synthesise 30 analysed games ----
function synth(n, seed) {
  let s = seed;
  const rnd = () => (s = (s*1664525+1013904223)>>>0) / 4294967296;
  const games = [];
  for (let i = 0; i < n; i++) {
    const g = new Chess();
    const moves = [];
    let ev = 20;
    const len = 40 + Math.floor(rnd()*50);
    const myColor = i % 2 === 0 ? 'w' : 'b';
    for (let p = 0; p < len; p++) {
      const ms = g.generate();
      if (!ms.length) break;
      const before = g.fen();
      const pick = ms[Math.floor(rnd()*ms.length)];
      const san = g.san(pick);
      // best = engine-ish: just take first generated move as "server best"
      const bestMv = ms[0];
      const bestUci = bestMv.fromSq + bestMv.toSq + (bestMv.promo ? Chess.SYM[bestMv.promo] : '');
      g.makeMove(pick);
      const mine = (pick.color === Chess.WHITE ? 'w':'b') === myColor;
      const drift = mine ? (rnd() < 0.12 ? -(150+rnd()*400) : -(rnd()*70)) : (rnd()*60-20);
      ev += (myColor === 'w' ? drift : -drift);
      ev = Math.max(-900, Math.min(900, ev));
      moves.push({ san, ply: p+1, color: pick.color === Chess.WHITE ? 'w':'b',
        fenBefore: before, fenAfter: g.fen(), evalAfter: Math.round(ev),
        serverBest: bestUci, serverLine: null,
        clock: Math.max(5, 600 - p*7 - rnd()*60),
        judgment: null });
    }
    games.push({ id: 'syn'+i, url: 'https://lichess.org/syn'+i, source:'lichess',
      date: Date.now() - Math.floor(rnd()*89)*86400000, speed:'rapid', perf:'rapid', rated:true,
      myColor, myName:'me', oppName:'opp'+i, myRating:2100, oppRating: 2050+Math.floor(rnd()*120),
      score: [0,0.5,1][Math.floor(rnd()*3)], result:'1-0',
      eco:'B12', openingName: i%3===0 ? 'Caro-Kann Defense: Advance' : (i%3===1?"Queen's Gambit Declined":'Sicilian Defense'),
      openingPly: 8, analysed:true, acpl: 30+Math.floor(rnd()*30), accuracy: 70,
      clockInitial: 600, clockIncrement: 0, moves });
  }
  return games;
}

const games = synth(30, 7);
const plies = games.reduce((a, g) => a + g.moves.length, 0);
check('synth: 30 games of 40 plies or more', games.length === 30 && games.every(g => g.moves.length >= 40), plies + ' plies');

const profile = Analysis.buildProfile(games, 2100);
const cal = profile.calibration;
check('profile: a measured strength with a margin', cal.trueStrength > 1500 && cal.trueStrength < 2600 && cal.marginOfError > 0,
      cal.trueStrength + ' +/- ' + cal.marginOfError);
check('profile: mistakes are mined, blunders among them', profile.counts.errors > 0 && profile.counts.blunders > 0 &&
      profile.counts.blunders <= profile.counts.errors && profile.errors.length === profile.counts.errors,
      profile.counts.errors + ' errors, ' + profile.counts.blunders + ' blunders');
check('profile: every mistake is the player\'s own move', profile.errors.every(e => {
  const g = games.find(x => x.id === e.gameId); return g && e.myColor === g.myColor; }), profile.errors.length);
const phaseErrors = ['opening', 'middlegame', 'endgame'].reduce((a, p) => a + (profile.phases[p] ? profile.phases[p].errors : 0), 0);
check('profile: the phases share out every mistake', phaseErrors === profile.counts.errors, phaseErrors + ' of ' + profile.counts.errors);
check('profile: motifs are sorted by centipawns lost, costliest first', profile.motifs.length > 0 &&
      profile.motifs.every((m, i) => i === 0 || profile.motifs[i - 1].cpLost >= m.cpLost),
      profile.motifs.slice(0, 6).map(m => m.motif + ':' + m.cpLost).join(', '));
const names = ['Caro-Kann Defense: Advance', "Queen's Gambit Declined", 'Sicilian Defense'];
check('profile: openings come from the games', profile.openings.length > 0 && profile.openings.every(o => names.some(n => n.indexOf(o.name) === 0) &&
      o.scorePct >= 0 && o.scorePct <= 100), profile.openings.slice(0, 3).map(o => o.name + '/' + o.color + ' ' + o.scorePct + '%').join(' | '));
check('profile: the clock-pressure rate is a fraction', profile.clock.pressureRate >= 0 && profile.clock.pressureRate <= 1, profile.clock.pressureRate);
const st = profile.style;
check('profile: style rates are fractions over the player\'s moves', ['captureRate', 'checkRate', 'pawnMoveRate'].every(k => st[k] >= 0 && st[k] <= 1) &&
      st.sampleMoves > 0 && st.sampleMoves <= plies, JSON.stringify(st));

// deck + scheduling
const cards = Training.buildDeck(profile.errors, {});
check('deck: a card per mistake at most, all due on a new deck', cards.length > 0 && cards.length <= profile.errors.length &&
      Training.dueCards(cards).length === cards.length, cards.length + ' cards, ' + Training.dueCards(cards).length + ' due');
check('deck: card ids are unique', new Set(cards.map(c => c.id)).size === cards.length, cards.length);
const plans = Training.planRange(new Date(), 7, profile, cards, { minutesBudget: 60, endgameTier: 2 });
check('plan: seven days, each within the 60-minute budget', plans.length === 7 && plans.every(p => p.totalMinutes > 0 && p.totalMinutes <= 60),
      plans.map(p => p.totalMinutes).join());
check('plan: every day starts with recall', plans.every(p => p.items.length && /recall/i.test(p.items[0].label)),
      plans.map(p => p.items[0] && p.items[0].label).join(' / '));
const ics = Training.toICS(plans, { hour: 19 });
const events = (ics.match(/BEGIN:VEVENT/g) || []).length;
const items = plans.reduce((a, p) => a + p.items.length, 0);
check('ics: one event per plan item, in a well-formed calendar', events === items && ics.startsWith('BEGIN:VCALENDAR') &&
      /END:VCALENDAR\s*$/.test(ics), events + ' events, ' + items + ' items');

// SRS: good, good, easy, again, good
const card = cards[0];
const ease0 = card.ease;
[2, 2, 3, 0, 2].forEach(gr => Training.review(card, gr));
check('srs: one lapse, and the interval starts again', card.lapses === 1 && card.reps === 1 && card.interval === 2,
      'lapses ' + card.lapses + ', reps ' + card.reps + ', interval ' + card.interval);
check('srs: ease moves +0.02 +0.02 +0.12 -0.25 +0.02', Math.abs(card.ease - (ease0 - 0.07)) < 1e-9, ease0.toFixed(2) + ' -> ' + card.ease.toFixed(2));
check('srs: retention is 4 of 5', Training.retention(card) === 0.8, Training.retention(card));

// coach
const game = games[0];
const transcript = {};
const good = 'I looked at Nf3 and Bb5, he threatens Qh4 so I defend; roughly equal after Bd2.';
let mine = 0;   // alternate the two notes over the player's own moves
game.moves.forEach((m, i) => { if (m.color === game.myColor && i < 10) { const text = mine++ % 2 ? good : 'looked natural'; transcript[i] = {
  text, san: m.san, score: Coach.scoreJustification(text, { best: 'Nf3', cpLoss: 200 }), cpLoss: 120, best: 'Nf3' }; } });
check('coach: a reasoned note outscores "looked natural"', (() => {
  const a = Coach.scoreJustification(good, { best: 'Nf3', cpLoss: 200 }), b = Coach.scoreJustification('looked natural', { best: 'Nf3', cpLoss: 200 });
  return a.candidates > b.candidates && a.opponentAwareness > b.opponentAwareness; })());
const summary = Coach.summarizeGame(game, transcript, profile.errors, profile);
const keys = ['concreteness', 'candidates', 'opponentAwareness', 'evaluation'];
check('coach: the weakest habit is the lowest-scored one', keys.indexOf(summary.weakest) >= 0 &&
      keys.every(k => summary.rubric[k] >= summary.rubric[summary.weakest]), JSON.stringify(summary.rubric) + ' weakest ' + summary.weakest);
check('coach: the summary names the opening', summary.narrative.length > 0 && summary.narrative[0].indexOf(game.openingName) >= 0, summary.narrative[0]);
check('coach: homework is set', summary.homework.length > 0, summary.homework.length);
const prompt = Coach.buildPrompt(game, transcript, summary, profile);
const noteLines = prompt.split('\n').filter(l => /^- Move \d+ /.test(l));
check('coach: the prompt carries the opening and one line per note', prompt.indexOf(game.openingName) >= 0 &&
      noteLines.length === Object.keys(transcript).length && prompt.indexOf('Bb5') >= 0 && prompt.indexOf('looked natural') >= 0,
      noteLines.length + ' of ' + Object.keys(transcript).length + ' notes, ' + prompt.length + ' chars');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
