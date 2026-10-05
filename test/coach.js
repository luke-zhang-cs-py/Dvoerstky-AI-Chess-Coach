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

  globalThis.fetch = keep;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})();
