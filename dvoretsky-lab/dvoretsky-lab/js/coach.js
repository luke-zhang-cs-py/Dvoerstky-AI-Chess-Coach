/* coach.js — justification scoring + game critique in the Dvoretsky method.
   The rubric encodes four habits his training was built on: enumerate candidate
   moves, ask what the opponent wants, calculate concretely instead of by
   principle, and state an honest evaluation at the end of every line. */
(function (root) {
  'use strict';

  var SAN_RE = /\b(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x?[a-h][1-8](?:=[QRBN])?|[a-h][1-8]|O-O(?:-O)?)\b/g;
  var OPP_WORDS = /\b(his|her|their|black'?s|white'?s|opponent|threat(?:en|ens|ening)?|reply|replies|answer|counter|defend|defence|defense|prophyla|stop|prevent|allow)\b/i;
  var CANDIDATE_WORDS = /\b(alternativ|instead|also considered|other option|candidate|compared|versus|vs\.?|or\b|either)\b/i;
  var EVAL_WORDS = /\b(equal|balanced|better|worse|winning|losing|slight|clearly|decisive|compensation|edge|advantage|drawn|unclear|\+[-=]|=|±|∓|⩲|⩱)\b/i;
  var HEDGE_WORDS = /\b(felt|looked|seemed|natural|instinct|gut|by feel|principle|usually|generally|always play|habit|why not)\b/i;

  /* Score one written justification against the position it was written for. */
  function scoreJustification(text, ctx) {
    text = String(text || '').trim();
    var words = text ? text.split(/\s+/).length : 0;
    var sans = text.match(SAN_RE) || [];
    var uniqueSans = sans.filter(function (v, i) { return sans.indexOf(v) === i; });

    var concreteness = Math.min(1, uniqueSans.length / 4) * 0.7 + Math.min(1, words / 45) * 0.3;
    var candidates = CANDIDATE_WORDS.test(text) ? 1 : (uniqueSans.length >= 3 ? 0.6 : 0.15);
    var opponent = OPP_WORDS.test(text) ? 1 : 0.1;
    var evaluation = EVAL_WORDS.test(text) ? 1 : 0.15;
    var hedging = HEDGE_WORDS.test(text) ? 1 : 0;

    // Did the writer see the move the position actually demanded?
    var sawBest = false, sawRefutation = false;
    if (ctx && ctx.best) {
      var bestCore = String(ctx.best).replace(/[+#!?]/g, '');
      sawBest = uniqueSans.some(function (s) { return s.replace(/[+#!?]/g, '') === bestCore; });
    }
    if (ctx && ctx.refutation) {
      var refCore = String(ctx.refutation).replace(/[+#!?]/g, '');
      sawRefutation = uniqueSans.some(function (s) { return s.replace(/[+#!?]/g, '') === refCore; });
    }

    var quality = (concreteness * 0.3 + candidates * 0.2 + opponent * 0.3 + evaluation * 0.2);
    if (hedging) quality *= 0.75;
    if (sawBest) quality = Math.min(1, quality + 0.15);

    return {
      words: words,
      lines: uniqueSans.length,
      concreteness: +concreteness.toFixed(2),
      candidates: +candidates.toFixed(2),
      opponentAwareness: +opponent.toFixed(2),
      evaluation: +evaluation.toFixed(2),
      hedging: !!hedging,
      sawBest: sawBest,
      sawRefutation: sawRefutation,
      quality: +quality.toFixed(2)
    };
  }

  /* Immediate response to a single justification. */
  function respond(entry, ctx) {
    var s = entry.score, out = [];
    var loss = ctx.cpLoss || 0;

    if (s.words < 6) {
      out.push('That is an assertion, not an analysis. Write the line you actually saw, to its end.');
    }
    if (s.opponentAwareness < 0.5) {
      out.push('Nothing in your note is about your opponent. Before you commit, finish the sentence "the move he wants to play is…".');
    }
    if (s.candidates < 0.5 && loss >= 100) {
      out.push('One move considered, and it was the wrong one. Name three candidates before you calculate any of them.');
    }
    if (s.hedging && loss >= 80) {
      out.push('You described how the move felt. Feeling is a way of generating candidates, never a way of choosing between them.');
    }
    if (s.evaluation < 0.5 && s.lines >= 2) {
      out.push('You calculated but did not evaluate. A variation without a verdict at the end is unfinished work.');
    }
    if (s.sawBest && loss >= 100) {
      out.push('You saw ' + ctx.best + ' and rejected it. That rejection is the thing worth examining, not the move you played.');
    } else if (!s.sawBest && ctx.best && loss >= 150) {
      out.push(ctx.best + ' was the move. It never entered your list, which makes this a pattern problem rather than a calculation error.');
    }
    if (!out.length) {
      if (loss < 30) out.push('Sound, and the reasoning matches the position.');
      else out.push('The reasoning is honest work. The move still leaks ' + Math.round(loss) + ' centipawns — check the third candidate you dismissed.');
    }
    return out;
  }

  /* Whole-game summary from the transcript plus the mined errors. */
  function summarizeGame(game, transcript, errors, profile) {
    var entries = Object.keys(transcript || {}).map(function (k) {
      return Object.assign({ ply: +k }, transcript[k]);
    }).sort(function (a, b) { return a.ply - b.ply; });

    var myErrors = (errors || []).filter(function (e) { return e.gameId === game.id; });
    var turning = myErrors.slice().sort(function (a, b) { return b.cpLoss - a.cpLoss; }).slice(0, 3);

    var avg = function (f) {
      if (!entries.length) return null;
      return +(entries.reduce(function (s, e) { return s + (e.score ? e.score[f] : 0); }, 0) / entries.length).toFixed(2);
    };

    var rubric = {
      concreteness: avg('concreteness'),
      candidates: avg('candidates'),
      opponentAwareness: avg('opponentAwareness'),
      evaluation: avg('evaluation'),
      coverage: entries.length
    };

    var weakest = null, weakVal = 2;
    ['concreteness', 'candidates', 'opponentAwareness', 'evaluation'].forEach(function (k) {
      if (rubric[k] != null && rubric[k] < weakVal) { weakVal = rubric[k]; weakest = k; }
    });

    var WEAK_TEXT = {
      concreteness: 'You reason in sentences where you should reason in moves. Across this game your notes averaged under two variations each.',
      candidates: 'You commit to the first move that appeals to you. The discipline to list three candidates before calculating any is the single cheapest rating you can buy.',
      opponentAwareness: 'Your analysis is almost entirely about your own plans. Most of what went wrong here was something your opponent wanted and you did not name.',
      evaluation: 'You calculate to the end of a line and then stop without judging the resulting position. That is how a good variation gets rejected and a bad one chosen.'
    };

    var phaseCost = { opening: 0, middlegame: 0, endgame: 0 };
    myErrors.forEach(function (e) { phaseCost[e.phase] += e.cpLoss; });
    var worstPhase = Object.keys(phaseCost).sort(function (a, b) { return phaseCost[b] - phaseCost[a]; })[0];

    var motifCount = {};
    myErrors.forEach(function (e) { (e.motifs || []).forEach(function (m) { motifCount[m] = (motifCount[m] || 0) + 1; }); });
    var motifList = Object.keys(motifCount).sort(function (a, b) { return motifCount[b] - motifCount[a]; });

    var narrative = [];
    narrative.push(openingLine(game, myErrors));
    if (turning.length) {
      narrative.push('The game turned on move ' + turning[0].moveNo + '. You played ' + turning[0].played +
        (turning[0].best ? ' where ' + turning[0].best + ' held' : '') + ', and the evaluation moved ' +
        (turning[0].cpLoss / 100).toFixed(1) + ' pawns against you' +
        (turning[0].timePressure ? ' — with under fifteen percent of your clock left, which is its own separate problem' : '') + '.');
    }
    if (turning.length > 1) {
      narrative.push('Two further losses of a pawn or more followed at moves ' +
        turning.slice(1).map(function (t) { return t.moveNo; }).join(' and ') +
        '. Note that they came after the first one: the damage in this game is sequential, not independent.');
    }
    if (phaseCost[worstPhase] > 0) {
      narrative.push('By phase, ' + Math.round(phaseCost[worstPhase]) + ' of your ' +
        Math.round(phaseCost.opening + phaseCost.middlegame + phaseCost.endgame) +
        ' lost centipawns came in the ' + worstPhase + '.');
    }
    if (weakest && entries.length >= 3) narrative.push(WEAK_TEXT[weakest]);
    else if (entries.length < 3) narrative.push('You justified only ' + entries.length + ' moves. The transcript is the exercise; a game reviewed without it is a game watched, not studied.');

    var homework = [];
    motifList.slice(0, 2).forEach(function (m) {
      homework.push('Drill ' + m + ' until you stop needing to calculate it. It cost you material in this game alone.');
    });
    if (turning.length) {
      homework.push('Set up the position after move ' + turning[0].moveNo + ' and find ' +
        (turning[0].best || 'the correct continuation') + ' from a cold start tomorrow, without the answer in front of you.');
    }
    if (worstPhase === 'endgame') homework.push('Add one theoretical endgame to this week before you touch another opening file.');
    if (profile && profile.clock && profile.clock.pressureRate > 25) {
      homework.push('A quarter of your errors arrive with the flag in sight. Practise reaching move thirty with half your clock.');
    }

    return {
      gameId: game.id,
      rubric: rubric,
      weakest: weakest,
      turningPoints: turning,
      phaseCost: phaseCost,
      motifs: motifList,
      narrative: narrative,
      homework: homework
    };
  }

  function openingLine(game, errs) {
    var name = game.openingName || 'an unlabelled opening';
    var openErrs = errs.filter(function (e) { return e.phase === 'opening'; });
    var side = game.myColor === 'w' ? 'White' : 'Black';
    if (!openErrs.length) {
      return 'You came out of ' + name + ' as ' + side + ' with the position intact. The theory is not the problem.';
    }
    return 'You left ' + name + ' already ' + Math.round(openErrs.reduce(function (s, e) { return s + e.cpLoss; }, 0)) +
      ' centipawns lighter as ' + side + ', at move ' + openErrs[0].moveNo + '. Worth checking whether you know the moves or the ideas.';
  }

  /* ---------------- optional LLM layer ---------------- */

  /* Builds the prompt; the caller decides whether to send it. Works with any
     model endpoint. The structured critique above is always available offline. */
  function buildPrompt(game, transcript, summary, profile) {
    var lines = [];
    lines.push('You are a chess trainer working in the tradition of Mark Dvoretsky: demanding, concrete, allergic to general principles used as substitutes for calculation. You are reviewing one game with a student rated around ' + ((profile && profile.calibration && profile.calibration.trueStrength) || '2100') + '.');
    lines.push('');
    lines.push('Game: ' + (game.openingName || 'unknown opening') + ', student played ' + (game.myColor === 'w' ? 'White' : 'Black') + ', result ' + game.result + '.');
    lines.push('');
    lines.push('The student wrote a justification before each of their moves. Their notes, with the engine verdict they had not yet seen:');
    Object.keys(transcript).sort(function (a, b) { return a - b; }).forEach(function (ply) {
      var t = transcript[ply];
      lines.push('- Move ' + Math.ceil(ply / 2) + ' (' + t.san + '): "' + (t.text || '').replace(/"/g, "'") + '"' +
        (t.cpLoss ? ' [cost ' + t.cpLoss + 'cp; engine preferred ' + (t.best || '?') + ']' : ' [sound]'));
    });
    lines.push('');
    lines.push('Recurring weaknesses across their last 90 days: ' +
      ((profile && profile.motifs || []).slice(0, 5).map(function (m) { return m.motif + ' (' + m.count + 'x)'; }).join(', ') || 'not yet measured') + '.');
    lines.push('');
    lines.push('Write at most 350 words. Address the thinking, not the moves. Identify the one habit that produced the most damage, quote their own words back to them where it exposes the habit, and end with a single piece of homework. Do not praise reflexively.');
    return lines.join('\n');
  }

  function callLLM(prompt, cfg) {
    if (!cfg || !cfg.apiKey) return Promise.reject(new Error('No API key set.'));
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: cfg.model || 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('API ' + r.status + ': ' + t.slice(0, 200)); });
      return r.json();
    }).then(function (d) {
      return (d.content || []).filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; }).join('\n');
    });
  }

  root.Coach = {
    scoreJustification: scoreJustification,
    respond: respond,
    summarizeGame: summarizeGame,
    buildPrompt: buildPrompt,
    callLLM: callLLM
  };
})(typeof window !== 'undefined' ? window : globalThis);
