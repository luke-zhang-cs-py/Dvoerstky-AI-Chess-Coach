// The coach's replies to a written justification, and the optional API call. Neither ran
// in any other suite before the 5 October 2026 audit. Run: node test/coach.js
globalThis.window = globalThis;
require('../js/core.js'); require('../js/coach.js');
const { Coach } = globalThis;

let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}
const reply = (text, ctx) => Coach.respond({ score: Coach.scoreJustification(text, ctx) }, ctx).join(' | ');

(async () => {
  // ---------------------------------------------------------------- October 2026 coverage round
  const blank = Coach.scoreJustification(undefined, {});
  check('score: no note at all is zero words and zero lines, not an error', blank.words === 0 && blank.lines === 0, JSON.stringify(blank));

  // A game reviewed with no transcript and no mined errors: nothing to average, nothing turned.
  const bare = Coach.summarizeGame({ id: 'g0', myColor: 'b' }, undefined, undefined, null);
  check('summary: no notes and no errors is an empty rubric, the coverage warning, and no homework',
    bare.rubric.coverage === 0 && bare.rubric.concreteness === null && bare.weakest === null && bare.turningPoints.length === 0
    && bare.narrative.length === 2 && /an unlabelled opening as Black with the position intact/.test(bare.narrative[0])
    && /You justified only 0 moves/.test(bare.narrative[1]) && bare.homework.length === 0, JSON.stringify(bare.narrative));

  // Two costly moves, the second later: "It came after the first one". A note saved without a
  // score (an old transcript) counts as zero, and an error with no motifs names none.
  const two = Coach.summarizeGame({ id: 'g1', myColor: 'w', openingName: 'Italian Game' },
    { 4: { text: 'Bc4' }, 10: { text: 'Nf3 because e5 is attacked', score: Coach.scoreJustification('Nf3 because e5 is attacked', {}) },
      12: { text: 'castle', score: Coach.scoreJustification('castle', {}) } },
    [{ gameId: 'g1', moveNo: 14, played: 'Qd2', best: 'Qe2', cpLoss: 300, phase: 'middlegame' },
     { gameId: 'g1', moveNo: 20, played: 'Rd1', cpLoss: 150, phase: 'middlegame', motifs: ['pin'] },
     { gameId: 'other', moveNo: 3, played: 'h4', cpLoss: 900, phase: 'opening' }], null);
  check('summary: a second costly move after the first is "It came after the first one"; another game\'s error is not counted',
    two.narrative.some((l) => l === 'One further costly move came at move 20. It came after the first one: the damage in this game is sequential, not independent.')
    && two.turningPoints.length === 2 && two.phaseCost.middlegame === 450 && two.phaseCost.opening === 0, JSON.stringify(two.narrative));
  check('summary: a note with no score averages as zero; three notes name the weakest habit',
    two.rubric.coverage === 3 && two.rubric.concreteness < 0.2 && two.weakest !== null && two.motifs.join() === 'pin'
    && two.homework.some((h) => /Drill pin/.test(h)), JSON.stringify(two.rubric));

  const three = Coach.summarizeGame({ id: 'g2', myColor: 'w' }, {},
    [{ gameId: 'g2', moveNo: 9, played: 'a3', best: 'Nf3', cpLoss: 400, phase: 'middlegame' },
     { gameId: 'g2', moveNo: 12, played: 'b3', cpLoss: 200, phase: 'middlegame' }, { gameId: 'g2', moveNo: 15, played: 'c3', cpLoss: 150, phase: 'endgame' }], null);
  check('summary: two further costly moves after the first are "They came after the first one"',
    three.narrative.some((l) => l === '2 further costly moves came at moves 12 and 15. They came after the first one: the damage in this game is sequential, not independent.'),
    JSON.stringify(three.narrative));

  const prompt = Coach.buildPrompt({ myColor: 'b', result: '0-1' }, { 3: { san: 'Nf6', cpLoss: 80 } }, null, null);
  check('prompt: no opening name, no engine move, no note: each has a plain stand-in',
    prompt.includes('Game: unknown opening, student played Black, result 0-1.') && prompt.includes('- Move 2 (Nf6): "" [cost 80cp; engine preferred ?]')
    && prompt.includes('around 2100') && prompt.includes('across all of their loaded games: not yet measured.'), prompt.split('\n').slice(2, 6).join(' / '));

  // ---------------------------------------------------------------- respond
  let r = reply('Nf3', { cpLoss: 0 });
  check('respond: a note of a word or two is an assertion', /assertion, not an analysis/.test(r), r);
  check('respond: ...and says nothing about the opponent', /Nothing in your note is about your opponent/.test(r));

  r = reply('I played it because it felt natural and I always play this move in this structure', { cpLoss: 120, best: 'Bxf7+' });
  check('respond: one move considered and wrong, by feel', /Name three candidates/.test(r) && /how the move felt/.test(r), r);

  r = reply('Nf3 then Nd4 Bxd4 Qxd4 and his threat on h7 is stopped', { cpLoss: 0 });
  check('respond: lines without a verdict are unfinished', /without a verdict/.test(r), r);

  r = reply('Candidates Bxf7+ or Nf3. After Bxf7+ Kxf7 Ng5+ his king is exposed but I judged it unclear, so Nf3 and White is slightly better.',
            { cpLoss: 140, best: 'Bxf7+' });
  check('respond: saw the best move and rejected it', /You saw Bxf7\+ and rejected it/.test(r), r);

  r = reply('Candidates Nf3 or c3. After Nf3 Nc6 d4 his threat on e4 is met and White is slightly better.', { cpLoss: 200, best: 'Qh5' });
  check('respond: never saw the best move: a pattern problem', /Qh5 was the move/.test(r), r);

  r = reply('Candidates Nf3 or c3. After Nf3 Nc6 d4 his threat on e4 is met and White is slightly better.', { cpLoss: 10 });
  check('respond: sound work on a sound move', /^Sound/.test(r), r);
  r = reply('Candidates Nf3 or c3. After Nf3 Nc6 d4 his threat on e4 is met and White is slightly better.', { cpLoss: 60 });
  check('respond: honest work on a move that still leaks', /leaks 60 centipawns/.test(r), r);

  // ---------------------------------------------------------------- scoring: the refutation
  const seen = Coach.scoreJustification('Bxf7+ Kxf7 Ng5+ wins', { best: 'Bxf7', refutation: 'Ng5' });
  const unseen = Coach.scoreJustification('Bxf7+ Kxf7 Qh5+ wins', { best: 'Bxf7', refutation: 'Ng5' });
  check('score: the refutation is seen when the note names it, check sign or not', seen.sawRefutation && !unseen.sawRefutation && seen.sawBest,
    seen.sawRefutation + ' / ' + unseen.sawRefutation);

  // ---------------------------------------------------------------- the whole-game summary
  {
    const game = { id: 'g1', openingName: 'Caro-Kann Defense', myColor: 'b', result: '1-0' };
    const errs = [
      { gameId: 'g1', moveNo: 31, played: 'Kd7', best: 'Ke6', cpLoss: 420, phase: 'endgame', motifs: ['pawn endgame'], timePressure: true },
      { gameId: 'g1', moveNo: 6, played: 'Bg4', best: 'e6', cpLoss: 90, phase: 'opening', motifs: [] },
      { gameId: 'g1', moveNo: 40, played: 'Kc6', best: null, cpLoss: 200, phase: 'endgame', motifs: ['pawn endgame'] },
      { gameId: 'other', moveNo: 3, played: 'Qh5', cpLoss: 999, phase: 'middlegame', motifs: ['pin'] }];
    const note = t => ({ text: t, score: Coach.scoreJustification(t, {}) });
    const tr = { 11: note('Bg4 develops'), 61: note('Kd7 because it felt natural'), 79: note('Kc6 Kd4 and his king is better') };
    const s = Coach.summarizeGame(game, tr, errs, { clock: { pressureRate: 30 } });
    const text = s.narrative.join(' ');
    check('summary: only this game\'s errors count, the costliest first', s.turningPoints.map(t => t.moveNo).join() === '31,40,6' &&
      s.phaseCost.middlegame === 0 && s.phaseCost.endgame === 620 && !s.motifs.includes('pin'), s.turningPoints.map(t => t.moveNo).join());
    check('summary: the turn names the move, the better one, the cost and the clock',
      /turned on move 31\. You played Kd7 where Ke6 held, and the evaluation moved 4\.2 pawns against you — with under fifteen percent/.test(text), s.narrative[1]);
    check('summary: two further costly moves, in move order, not all after the first',
      s.narrative[2] === '2 further costly moves came at moves 6 and 40.', s.narrative[2]);
    check('summary: the phase that cost most, out of the total', /620 of your 710 lost centipawns came in the endgame/.test(text), text.slice(0, 80));
    check('summary: the rubric averages three notes, and the weakest habit gets its paragraph',
      s.rubric.coverage === 3 && s.weakest === 'candidates' && /list three candidates/.test(s.narrative[4]), JSON.stringify(s.rubric));
    check('summary: homework for the pattern, the position, the endgame and the clock',
      s.homework.length === 4 && /^Drill pawn endgame/.test(s.homework[0]) && /after move 31 and find Ke6/.test(s.homework[1]) &&
      /theoretical endgame/.test(s.homework[2]) && /flag in sight/.test(s.homework[3]), s.homework.join(' | '));
    const prompt = Coach.buildPrompt(game, { 11: { san: 'Bg4', text: 'say "hi"', cpLoss: 90, best: 'e6' }, 0: { san: 'e4', text: '' } }, s,
      { windowDays: 30, motifs: [{ motif: 'pin', count: 3 }], calibration: { trueStrength: 1850 } });
    check('prompt: the rating, the notes in move order with quotes made safe, and the window\'s weaknesses',
      /rated around 1850\./.test(prompt) && prompt.indexOf('- Move 1 (e4): "" [sound]') < prompt.indexOf('- Move 6 (Bg4): "say \'hi\'" [cost 90cp; engine preferred e6]') &&
      prompt.indexOf('- Move 1 (e4)') > 0 && /across their last 30 days: pin \(3x\)\./.test(prompt), prompt.split('\n').filter(l => /^- |Recurring/.test(l)).join(' | '));
  }

  // ---------------------------------------------------------------- callLLM
  const keep = globalThis.fetch;
  let sent = null;
  const answer = (res) => { globalThis.fetch = (url, opts) => { sent = { url, opts }; return Promise.resolve(res); }; };
  const call = cfg => Coach.callLLM('the prompt', cfg).then(t => 'ok ' + t, e => 'err ' + e.message);

  check('callLLM: no key, no request', (await call({})) === 'err No API key set.' && sent === null);

  answer({ ok: true, json: () => Promise.resolve({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Verdict.' }], stop_reason: 'end_turn' }) });
  r = await call({ apiKey: 'k', model: 'some-model' });
  const body = JSON.parse(sent.opts.body);
  check('callLLM: the text blocks are the verdict', r === 'ok Verdict.', r);
  check('callLLM: the key goes in the header, the chosen model in the body',
    sent.opts.headers['x-api-key'] === 'k' && body.model === 'some-model' && body.messages[0].content === 'the prompt');

  answer({ ok: false, status: 401, text: () => Promise.resolve('{"error":"invalid x-api-key"}') });
  r = await call({ apiKey: 'bad' });
  check('callLLM: an HTTP error carries the status and the start of the body', /^err API 401: \{"error"/.test(r), r);

  answer({ ok: true, json: () => Promise.resolve({ content: [{ type: 'thinking', thinking: 'hmm' }], stop_reason: 'max_tokens' }) });
  r = await call({ apiKey: 'k' });
  check('callLLM: an answer with no text is an error naming the stop reason, and the default model is asked',
    r === 'err The model sent no text (stop reason: max_tokens).' && JSON.parse(sent.opts.body).model === 'claude-sonnet-4-6', r);

  answer({ ok: true, json: () => Promise.resolve({}) });
  r = await call({ apiKey: 'k' });
  check('callLLM: an answer with no content and no stop reason says so plainly', r === 'err The model sent no text (stop reason: none given).', r);

  globalThis.fetch = keep;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})();
