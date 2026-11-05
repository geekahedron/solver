'use strict';

const assert = require('assert');
const path = require('path');

const Core = require(path.join(__dirname, '..', 'src/core.js'));
const Pack = require(path.join(__dirname, '..', 'src/pack.js'));
const Engine = require(path.join(__dirname, '..', 'src/engine.js'));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('ok', name);
}

function packOf(answers, guesses) {
  const pack = Pack.fromCustom({
    length: answers[0].length,
    alphabet: 'abcdefghijklmnopqrstuvwxyz',
    caseInsensitive: true,
    tokens: false,
    rule: 'wordle'
  });
  return Engine.create(pack, {
    answers: answers.join('\n'),
    guesses: (guesses || []).join('\n')
  });
}

function depth(eng, word, opts) {
  opts = opts || {};
  const search = Core.prepareDepthSearch({
    U: eng.U,
    L: eng.pack.length,
    K: eng.syms.length,
    rule: eng.feedbackRule,
    rem: opts.rem || eng.knownIdx.slice(),
    guessIdx: eng.guessIdx,
    clues: opts.clues || [],
    hard: opts.hard || 'off',
    guessMode: opts.guessMode || 'dictionary',
    budget: opts.budget,
    beam: opts.beam,
    beamOnly: opts.beamOnly,
    nodeCap: opts.nodeCap,
    timeCapMs: opts.timeCapMs == null ? 5000 : opts.timeCapMs,
    exactLimit: opts.exactLimit
  });
  return search.evaluate(eng.keyIdx.get(word));
}

// Family ab? plus a probe xyw. Guessing abc locks "ab" and, once hard mode
// is on, leaves the *ab? words to be guessed one at a time. Hard off can
// still play xyw and split that family. One-ply splits like abc (many
// patterns) even though the hard-mode depth is worse.
const TRAP_ANSWERS = ['abc', 'abx', 'aby', 'abz', 'abw', 'def', 'aef', 'ebc', 'bac', 'cab'];
const TRAP_GUESSES = ['xyw', 'aba', 'abb', 'abd', 'abe', 'abf', 'aaa', 'bbb', 'mmm'];

check('exact depth on a one-word, two-word, and three-word list', function () {
  const one = packOf(['aa'], []);
  const d1 = depth(one, 'aa', { budget: 1, guessMode: 'answersOnly' });
  assert.strictEqual(d1.maxSteps, 1);
  assert.strictEqual(d1.maxExact, true);
  assert.strictEqual(d1.guaranteed, true);

  const two = packOf(['aa', 'bb'], []);
  const d2 = depth(two, 'aa', { budget: 1, guessMode: 'answersOnly' });
  assert.strictEqual(d2.maxSteps, 2);
  assert.strictEqual(d2.maxExact, true);
  assert.strictEqual(d2.guaranteed, false);
  assert.strictEqual(depth(two, 'aa', { budget: 2, guessMode: 'answersOnly' }).guaranteed, true);

  const three = packOf(['aa', 'ab', 'ac'], []);
  ['aa', 'ab', 'ac'].forEach(function (w) {
    const row = depth(three, w, { budget: 3, guessMode: 'answersOnly' });
    assert.strictEqual(row.maxSteps, 3, w);
    assert.strictEqual(row.maxExact, true, w);
  });
  assert.strictEqual(depth(three, 'aa', { budget: 2, guessMode: 'answersOnly' }).guaranteed, false);
});

check('hard mode turns a good-looking guess into a trap; hard off does not', function () {
  const eng = packOf(TRAP_ANSWERS, TRAP_GUESSES);
  const off = depth(eng, 'abc', { budget: 4, hard: 'off', guessMode: 'dictionary' });
  const wordle = depth(eng, 'abc', { budget: 4, hard: 'wordle', guessMode: 'dictionary' });
  const strict = depth(eng, 'abc', { budget: 4, hard: 'strict', guessMode: 'dictionary' });
  const probe = depth(eng, 'xyw', { budget: 4, hard: 'wordle', guessMode: 'dictionary' });

  assert.strictEqual(off.maxSteps, 3);
  assert.strictEqual(off.maxExact, true);
  assert.strictEqual(off.guaranteed, true);

  assert.strictEqual(wordle.maxSteps, 5);
  assert.strictEqual(wordle.maxExact, true);
  assert.strictEqual(wordle.guaranteed, false);
  assert.strictEqual(strict.maxSteps, 5);
  assert.strictEqual(strict.guaranteed, false);
  // One-ply worst is the family bucket, not the multi-ply depth.
  const scores = Core.scorePool(
    eng.U, 3, eng.syms.length, 'wordle',
    Int32Array.from(eng.knownIdx),
    Int32Array.from([eng.keyIdx.get('abc')]),
    new Uint8Array(eng.nWords)
  );
  assert.strictEqual(scores[0].worst, 4);
  assert.notStrictEqual(scores[0].worst, wordle.maxSteps);

  assert.strictEqual(probe.maxSteps, 3);
  assert.strictEqual(probe.guaranteed, true);
});

check('guess mode changes the same continuation the way hard mode does', function () {
  const eng = packOf(TRAP_ANSWERS, TRAP_GUESSES);
  const dict = depth(eng, 'abc', { budget: 4, hard: 'off', guessMode: 'dictionary' });
  const anyMode = depth(eng, 'abc', { budget: 4, hard: 'off', guessMode: 'any' });
  const answers = depth(eng, 'abc', { budget: 4, hard: 'off', guessMode: 'answersOnly' });
  const hardMode = depth(eng, 'abc', { budget: 4, hard: 'off', guessMode: 'hard' });
  assert.strictEqual(dict.maxSteps, 3);
  assert.strictEqual(anyMode.maxSteps, dict.maxSteps);
  assert.strictEqual(answers.maxSteps, 5);
  assert.strictEqual(answers.guaranteed, false);
  assert.strictEqual(hardMode.maxSteps, 5);
  assert.strictEqual(hardMode.guaranteed, false);
});

check('clues already entered constrain later plies', function () {
  const eng = packOf(TRAP_ANSWERS, TRAP_GUESSES);
  const clue = eng.makeClue('abc', eng.feedbackDigits('abc', 'abx'));
  const rem = eng.knownIdx.filter(function (i) { return eng.feedbackPat(clue.ids, i) === clue.pat; });
  assert.deepStrictEqual(rem.map(function (i) { return eng.keys[i]; }).sort(), ['abw', 'abx', 'aby', 'abz']);
  const locked = depth(eng, 'abx', {
    budget: 3, hard: 'wordle', guessMode: 'dictionary', rem: rem,
    clues: [{ ids: clue.ids, pat: clue.pat, digits: clue.digits }]
  });
  const open = depth(eng, 'abx', {
    budget: 3, hard: 'off', guessMode: 'dictionary', rem: rem, clues: []
  });
  assert.strictEqual(locked.maxSteps, 4);
  assert.strictEqual(locked.maxExact, true);
  assert.strictEqual(locked.guaranteed, false);
  assert.strictEqual(open.maxSteps, 3);
  assert.strictEqual(open.guaranteed, true);
});

check('guarantee off keeps the trap; guarantee on drops it and keeps the probe', function () {
  const eng = packOf(TRAP_ANSWERS, TRAP_GUESSES);
  const rem = Int32Array.from(eng.knownIdx);
  const pool = Int32Array.from(eng.guessIdx);
  const isCand = new Uint8Array(eng.nWords);
  eng.knownIdx.forEach(function (i) { isCand[i] = 1; });
  const base = {
    U: eng.U, L: 3, K: eng.syms.length, rule: 'wordle',
    rem: rem, guessIdx: eng.guessIdx, clues: [],
    hard: 'wordle', guessMode: 'dictionary', budget: 4,
    mode: 'splits', topN: 10, timeCapMs: 5000
  };
  const scores = Core.scorePool(eng.U, 3, eng.syms.length, 'wordle', rem, pool, isCand);
  const off = Core.finishScores(scores.map(function (s) { return Object.assign({}, s); }), Object.assign({}, base, { guarantee: false }));
  const on = Core.finishScores(scores.map(function (s) { return Object.assign({}, s); }), Object.assign({}, base, { guarantee: true }));
  const name = function (row) { return eng.keys[row.idx]; };
  assert.strictEqual(name(off.top[0]), 'abc');
  assert.ok(off.top.some(function (row) { return name(row) === 'abc' && row.maxSteps === 5 && row.guaranteed === false; }));
  assert.ok(on.top.every(function (row) { return name(row) !== 'abc'; }));
  assert.ok(on.top.some(function (row) { return name(row) === 'xyw' && row.maxSteps === 3 && row.guaranteed === true; }));
  assert.ok(on.depth.exceeded >= 1);
  assert.notDeepStrictEqual(off.top.map(name), on.top.map(name));
});

check('steps mode keeps expected-steps order among guesses that prove Max steps', function () {
  const eng = packOf(TRAP_ANSWERS, TRAP_GUESSES);
  const rem = Int32Array.from(eng.knownIdx);
  const pool = Int32Array.from(eng.guessIdx);
  const isCand = new Uint8Array(eng.nWords);
  eng.knownIdx.forEach(function (i) { isCand[i] = 1; });
  const base = {
    U: eng.U, L: 3, K: eng.syms.length, rule: 'wordle',
    rem: rem, pool: pool, guessIdx: eng.guessIdx, dict: eng.guessIdx, clues: [],
    hard: 'wordle', guessMode: 'dictionary', budget: 4,
    mode: 'steps', topN: 30, timeCapMs: 5000
  };
  const scores = Core.scorePool(eng.U, 3, eng.syms.length, 'wordle', rem, pool, isCand);
  const off = Core.finishScores(scores.map(function (s) { return Object.assign({}, s); }), Object.assign({}, base, { guarantee: false }));
  const on = Core.finishScores(scores.map(function (s) { return Object.assign({}, s); }), Object.assign({}, base, { guarantee: true }));
  const name = function (row) { return eng.keys[row.idx]; };
  function sortedBySteps(rows) {
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].steps <= rows[i].steps, name(rows[i - 1]) + ' then ' + name(rows[i]));
    }
  }
  off.top.forEach(function (row) {
    assert.strictEqual(typeof row.steps, 'number');
    assert.ok(row.approx === 0 || row.approx === 1);
  });
  assert.ok(off.top.some(function (row) { return name(row) === 'abc' && row.maxSteps > 4; }));
  assert.ok(on.top.every(function (row) { return name(row) !== 'abc' && row.guaranteed && row.maxSteps <= 4; }));
  assert.ok(on.top.some(function (row) { return name(row) === 'xyw'; }));
  sortedBySteps(off.top);
  sortedBySteps(on.top);
  const proved = off.top.filter(function (row) { return row.maxSteps != null && row.maxSteps <= 4; });
  assert.strictEqual(name(on.top[0]), name(proved[0]));
  let prev = -1;
  on.top.forEach(function (row) {
    const at = off.top.map(name).indexOf(name(row));
    assert.ok(at > prev);
    prev = at;
  });
});

check('a beamed search never reports a guarantee it did not prove', function () {
  // mmm leaves all four answers together. xyw is the only guess that splits
  // them inside a 3-step budget. An empty beam may still use the real
  // strategy "guess remaining answers one by one" (depth 5) and must not
  // claim that 5-step line fits in 3. A full search proves depth 3.
  const eng = packOf(['abx', 'aby', 'abz', 'abw'], ['xyw', 'aba', 'abb', 'abc', 'abd', 'abe', 'abf', 'aaa', 'bbb', 'mmm']);
  const full = depth(eng, 'mmm', { budget: 3, hard: 'off', beam: 50 });
  const blind = depth(eng, 'mmm', { budget: 3, hard: 'off', beam: 0, beamOnly: true });
  const rushed = depth(eng, 'mmm', { budget: 3, hard: 'off', beam: 50, timeCapMs: 0 });
  assert.strictEqual(full.maxSteps, 3);
  assert.strictEqual(full.maxExact, true);
  assert.strictEqual(full.guaranteed, true);

  assert.strictEqual(blind.guaranteed, false);
  assert.strictEqual(blind.maxExact, false);
  assert.ok(blind.maxSteps == null || blind.maxSteps > 3);
  assert.strictEqual(blind.approx, true);

  assert.strictEqual(rushed.guaranteed, false);
  assert.ok(rushed.maxSteps == null || rushed.maxSteps > 3);
  // The trap itself stays over budget no matter how wide the beam is.
  const trap = packOf(TRAP_ANSWERS, TRAP_GUESSES);
  const wide = depth(trap, 'abc', { budget: 4, hard: 'wordle', beam: 100 });
  assert.strictEqual(wide.guaranteed, false);
  assert.ok(wide.maxSteps > 4);
});

try {
  console.log(passed + ' passed');
} catch (err) {
  console.error(err);
  process.exit(1);
}
