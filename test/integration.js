// Load modules in browser order with a fake global root
globalThis.window = globalThis;
require('../js/core.js'); require('../js/engine.js'); require('../js/data.js');
require('../js/analysis.js'); require('../js/training.js'); require('../js/coach.js');
require('../js/sparring.js');
const { Chess, Engine, Analysis, Training, Coach, Sparring, Data } = globalThis;

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
console.log('synth games:', games.length, 'plies:', games.reduce((a,g)=>a+g.moves.length,0));

let t0 = Date.now();
const profile = Analysis.buildProfile(games, 2100);
console.log('buildProfile ms:', Date.now()-t0);
console.log('calibration:', profile.calibration.trueStrength, '±', profile.calibration.marginOfError);
console.log('errors:', profile.counts.errors, 'blunders:', profile.counts.blunders);
console.log('phases:', JSON.stringify(profile.phases.middlegame));
console.log('top motifs:', profile.motifs.slice(0,6).map(m=>`${m.motif}:${m.count}`).join(', '));
console.log('openings:', profile.openings.slice(0,3).map(o=>`${o.name}/${o.color} ${o.scorePct}%`).join(' | '));
console.log('clock pressure:', profile.clock.pressureRate);
console.log('style:', JSON.stringify(profile.style));

// deck + scheduling
const cards = Training.buildDeck(profile.errors, {});
const deck = {}; cards.forEach(c => deck[c.id]=c);
console.log('\ndeck size:', cards.length, 'due now:', Training.dueCards(cards).length);
const plans = Training.planRange(new Date(), 7, profile, cards, { minutesBudget: 60, endgameTier: 2 });
plans.slice(0,3).forEach(p => console.log(p.weekday, p.totalMinutes+'min:', p.items.map(i=>i.label+(i.count?`(${i.count})`:'')).join(' / ')));
const ics = Training.toICS(plans, { hour: 19 });
console.log('ics events:', (ics.match(/BEGIN:VEVENT/g)||[]).length, '| valid header:', ics.startsWith('BEGIN:VCALENDAR'));

// SRS
let card = cards[0];
[2,2,3,0,2].forEach(gr => Training.review(card, gr));
console.log('srs after 5 reviews: interval', card.interval, 'ease', card.ease.toFixed(2), 'lapses', card.lapses, 'retention', Training.retention(card));

// coach
const game = games[0];
const transcript = {};
game.moves.forEach((m,i)=>{ if(m.color===game.myColor && i<10) transcript[i] = {
  text: i%2 ? 'I looked at Nf3 and Bb5, he threatens Qh4 so I defend; roughly equal after Bd2.' : 'looked natural',
  san: m.san, score: Coach.scoreJustification(i%2 ? 'I looked at Nf3 and Bb5, he threatens Qh4 so I defend; roughly equal after Bd2.' : 'looked natural', {best:'Nf3', cpLoss: 200}),
  cpLoss: 120, best:'Nf3' }; });
const summary = Coach.summarizeGame(game, transcript, profile.errors, profile);
console.log('\nrubric:', JSON.stringify(summary.rubric), 'weakest:', summary.weakest);
summary.narrative.forEach(n=>console.log(' -', n));
console.log('homework:', summary.homework.length, 'items');
console.log('prompt chars:', Coach.buildPrompt(game, transcript, summary, profile).length);
