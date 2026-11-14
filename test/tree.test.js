'use strict';

const assert = require('assert');
const path = require('path');

const Core = require(path.join(__dirname, '..', 'src/core.js'));
require(path.join(__dirname, '..', 'src/tree.js'));
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

function cluePayload(clues) {
  return (clues || []).map(function (c) {
    return { ids: c.ids, pat: c.pat, digits: c.digits };
  });
}

function build(eng, word, opts) {
  opts = opts || {};
  const enc = eng.encode(word);
  if (enc.err) throw new Error(enc.err);
  const idx = eng.keyIdx.has(enc.key) ? eng.keyIdx.get(enc.key) : -1;
  const rem = opts.rem || eng.knownIdx.slice();
  return Core.buildOpenerTree({
    U: eng.U,
    L: eng.pack.length,
    K: eng.syms.length,
    rule: eng.feedbackRule,
    rem: rem,
    guessIdx: opts.guessIdx || eng.guessIdx,
    clues: cluePayload(opts.clues),
    hard: opts.hard || 'off',
    guessMode: opts.guessMode || 'dictionary',
    opener: idx,
    openerIds: enc.ids,
    budget: opts.budget == null ? 6 : opts.budget,
    policy: opts.policy || 'worst',
    limits: Object.assign({ timeCapMs: 5000 }, opts.limits || {})
  });
}

function byKey(eng, tree) {
  const out = {};
  tree.depths.forEach(function (d) { out[eng.keys[d.idx]] = d; });
  return out;
}

function assertAccounting(tree) {
  const s = tree.summary;
  assert.strictEqual(tree.depths.length, s.answers);
  const seen = new Set();
  tree.depths.forEach(function (d) {
    assert.ok(!seen.has(d.idx), 'duplicate answer');
    seen.add(d.idx);
    if (d.proved) assert.strictEqual(d.pats.length, d.depth);
  });
  if (tree.root && s.playedOut) {
    assert.strictEqual(tree.root.provedCount + tree.root.unproved, s.answers);
    assert.strictEqual(tree.root.maxDepth, s.maxDepth);
    assert.strictEqual(tree.root.over, s.overBudget);
  }
}

function minimax(eng, word, opts) {
  opts = opts || {};
  const search = Core.prepareDepthSearch({
    U: eng.U,
    L: eng.pack.length,
    K: eng.syms.length,
    rule: eng.feedbackRule,
    rem: opts.rem || eng.knownIdx.slice(),
    guessIdx: eng.guessIdx,
    clues: cluePayload(opts.clues),
    hard: opts.hard || 'off',
    guessMode: opts.guessMode || 'dictionary',
    budget: opts.budget == null ? 8 : opts.budget,
    beam: 80,
    nodeCap: 50000,
    timeCapMs: 5000,
    exactLimit: 20
  });
  return search.evaluate(eng.keyIdx.get(word));
}

const TRAP_ANSWERS = ['abc', 'abx', 'aby', 'abz', 'abw', 'def', 'aef', 'ebc', 'bac', 'cab'];
const TRAP_GUESSES = ['xyw', 'aba', 'abb', 'abd', 'abe', 'abf', 'aaa', 'bbb', 'mmm'];

check('known depths on one, two, and three answers', function () {
  const one = build(packOf(['aa'], []), 'aa', { budget: 1, guessMode: 'answersOnly' });
  assertAccounting(one);
  assert.strictEqual(one.summary.maxDepth, 1);
  assert.strictEqual(one.summary.expected, 1);
  assert.strictEqual(one.summary.overBudget, 0);
  assert.strictEqual(one.summary.guaranteed, true);
  assert.strictEqual(one.summary.strategyFits, true);
  assert.strictEqual(one.summary.policyApprox, false);

  const twoEng = packOf(['aa', 'bb'], []);
  const two = build(twoEng, 'aa', { budget: 2, guessMode: 'answersOnly' });
  assertAccounting(two);
  const twoMap = byKey(twoEng, two);
  assert.strictEqual(twoMap.aa.depth, 1);
  assert.strictEqual(twoMap.bb.depth, 2);
  assert.strictEqual(two.summary.expected, 1.5);
  assert.strictEqual(two.summary.sum, 3);
  assert.strictEqual(two.summary.maxDepth, 2);
  assert.strictEqual(two.summary.guaranteed, true);
  const twoTight = build(twoEng, 'aa', { budget: 1, guessMode: 'answersOnly' });
  assert.strictEqual(twoTight.summary.guaranteed, false);
  assert.strictEqual(twoTight.summary.overBudget, 1);
  assert.strictEqual(twoTight.summary.provedImpossible, true);
  assert.strictEqual(byKey(twoEng, twoTight).bb.depth, 2);

  const threeEng = packOf(['aa', 'ab', 'ac'], []);
  const three = build(threeEng, 'aa', { budget: 2, guessMode: 'answersOnly' });
  assertAccounting(three);
  const threeMap = byKey(threeEng, three);
  assert.strictEqual(threeMap.aa.depth, 1);
  assert.strictEqual(threeMap.ab.depth, 2);
  assert.strictEqual(threeMap.ac.depth, 3);
  assert.strictEqual(three.summary.expected, 2);
  assert.strictEqual(three.summary.sum, 6);
  assert.strictEqual(three.summary.maxDepth, 3);
  assert.strictEqual(three.summary.overBudget, 1);
  assert.strictEqual(three.summary.guaranteed, false);
  assert.strictEqual(three.summary.provedImpossible, true);
  assert.strictEqual(three.summary.policyApprox, false);
  assert.strictEqual(minimax(threeEng, 'aa', { guessMode: 'answersOnly' }).maxSteps, 3);
});

check('a wasted opener still spends the guess, then the policy splits', function () {
  const eng = packOf(['aa', 'ab', 'ac'], ['zz', 'ba']);
  const worst = build(eng, 'zz', { budget: 3, policy: 'worst' });
  assertAccounting(worst);
  assert.strictEqual(worst.root.wasted, true);
  assert.strictEqual(eng.keys[worst.root.children[0].node.guess], 'ba');
  assert.strictEqual(worst.summary.maxDepth, 3);
  assert.strictEqual(worst.summary.expected, 3);
  assert.strictEqual(worst.summary.overBudget, 0);
  assert.strictEqual(worst.summary.guaranteed, true);
  worst.depths.forEach(function (d) { assert.strictEqual(d.depth, 3); });

  const steps = build(eng, 'zz', { budget: 3, policy: 'steps' });
  assert.strictEqual(eng.keys[steps.root.children[0].node.guess], 'ba');
  assert.strictEqual(steps.summary.maxDepth, 3);

  const tight = build(eng, 'zz', { budget: 2, policy: 'worst' });
  assert.strictEqual(tight.summary.overBudget, 3);
  assert.strictEqual(tight.summary.provedImpossible, true);
  assert.strictEqual(tight.summary.guaranteed, false);

  const answersOnly = build(eng, 'zz', { budget: 4, guessMode: 'answersOnly', policy: 'worst' });
  assert.strictEqual(answersOnly.summary.openerOutsidePool, true);
  assert.notStrictEqual(eng.keys[answersOnly.root.children[0].node.guess], 'ba');
  assert.strictEqual(answersOnly.summary.maxDepth, 4);
  const ao = byKey(eng, answersOnly);
  assert.strictEqual(ao.aa.depth, 2);
  assert.strictEqual(ao.ab.depth, 3);
  assert.strictEqual(ao.ac.depth, 4);
});

check('hard mode trap branch exceeds n; hard off does not', function () {
  const eng = packOf(TRAP_ANSWERS, TRAP_GUESSES);
  const hard = build(eng, 'abc', { budget: 4, hard: 'wordle', policy: 'worst' });
  assertAccounting(hard);
  assert.strictEqual(hard.summary.policyApprox, false);
  assert.strictEqual(hard.summary.maxDepth, 5);
  assert.strictEqual(hard.summary.guaranteed, false);
  assert.strictEqual(hard.summary.strategyFits, false);
  assert.strictEqual(hard.summary.provedImpossible, true);
  assert.strictEqual(hard.summary.overBudget, 1);
  assert.strictEqual(hard.summary.unproved, 0);
  assert.strictEqual(minimax(eng, 'abc', { hard: 'wordle', budget: 8 }).maxSteps, hard.summary.maxDepth);

  const famPat = eng.pattern(eng.tokens[eng.keyIdx.get('abc')], eng.tokens[eng.keyIdx.get('abx')]);
  const fam = hard.root.children.filter(function (ch) { return ch.pat === famPat; });
  assert.strictEqual(fam.length, 1);
  assert.strictEqual(fam[0].n, 4);
  assert.strictEqual(eng.keys[fam[0].node.guess], 'abx');
  assert.notStrictEqual(eng.keys[fam[0].node.guess], 'xyw');
  const hardMap = byKey(eng, hard);
  assert.strictEqual(hardMap.abc.depth, 1);
  assert.strictEqual(hardMap.abx.depth, 2);
  assert.strictEqual(hardMap.aby.depth, 3);
  assert.strictEqual(hardMap.abz.depth, 4);
  assert.strictEqual(hardMap.abw.depth, 5);
  ['abx', 'aby', 'abz', 'abw'].forEach(function (w) {
    assert.strictEqual(hardMap[w].pats[0], famPat);
  });
  assert.ok(hardMap.abw.depth > 4);
  ['def', 'aef', 'ebc', 'bac', 'cab'].forEach(function (w) {
    assert.ok(hardMap[w].depth <= 2, w);
  });

  const hardFits = build(eng, 'abc', { budget: 5, hard: 'wordle', policy: 'worst' });
  assert.strictEqual(hardFits.summary.maxDepth, 5);
  assert.strictEqual(hardFits.summary.overBudget, 0);
  assert.strictEqual(hardFits.summary.guaranteed, true);

  const off = build(eng, 'abc', { budget: 4, hard: 'off', policy: 'worst' });
  assertAccounting(off);
  assert.strictEqual(off.summary.maxDepth, 3);
  assert.strictEqual(off.summary.overBudget, 0);
  assert.strictEqual(off.summary.guaranteed, true);
  assert.strictEqual(off.summary.provedImpossible, false);
  assert.strictEqual(minimax(eng, 'abc', { hard: 'off', budget: 8 }).maxSteps, 3);
  const offFam = off.root.children.filter(function (ch) { return ch.pat === famPat; })[0];
  assert.strictEqual(eng.keys[offFam.node.guess], 'xyw');
  assert.strictEqual(offFam.maxDepth, 3);

  const probe = build(eng, 'xyw', { budget: 4, hard: 'wordle', policy: 'worst' });
  assert.strictEqual(probe.summary.maxDepth, 3);
  assert.strictEqual(probe.summary.guaranteed, true);
  assert.strictEqual(probe.summary.overBudget, 0);
  assert.strictEqual(minimax(eng, 'xyw', { hard: 'wordle', budget: 8 }).maxSteps, 3);
});

check('prior clues keep the hard-mode trap on the next guess', function () {
  const eng = packOf(TRAP_ANSWERS, TRAP_GUESSES);
  const made = eng.makeClue('abc', eng.feedbackDigits('abc', 'abx'));
  const clue = { ids: made.ids, pat: made.pat, digits: made.digits };
  const rem = eng.knownIdx.filter(function (i) { return eng.feedbackPat(clue.ids, i) === clue.pat; });
  assert.deepStrictEqual(rem.map(function (i) { return eng.keys[i]; }).sort(), ['abw', 'abx', 'aby', 'abz']);
  const locked = build(eng, 'abx', {
    budget: 3, hard: 'wordle', guessMode: 'dictionary', rem: rem, clues: [clue]
  });
  assertAccounting(locked);
  assert.strictEqual(locked.summary.maxDepth, 4);
  assert.strictEqual(locked.summary.guaranteed, false);
  assert.strictEqual(locked.summary.provedImpossible, true);
  const map = byKey(eng, locked);
  assert.strictEqual(map.abx.depth, 1);
  assert.strictEqual(map.aby.depth, 2);
  assert.strictEqual(map.abz.depth, 3);
  assert.strictEqual(map.abw.depth, 4);
  assert.strictEqual(minimax(eng, 'abx', { hard: 'wordle', budget: 8, rem: rem, clues: [clue] }).maxSteps, 4);

  const open = build(eng, 'abx', { budget: 3, hard: 'off', rem: rem, clues: [] });
  // abx leaves the other three together; a probe then finishes them on the next guess.
  assert.strictEqual(open.summary.maxDepth, 3);
  assert.strictEqual(open.summary.guaranteed, true);
  assert.strictEqual(minimax(eng, 'abx', { hard: 'off', budget: 8, rem: rem, clues: [] }).maxSteps, 3);
  const clump = open.root.children.filter(function (ch) { return !ch.solved && ch.n === 3; })[0];
  assert.ok(clump);
  assert.strictEqual(eng.keys[clump.node.guess], 'xyw');
});

check('a cut-off search does not claim a guarantee', function () {
  const eng = packOf(['aa', 'ab', 'ac'], []);
  const cut = build(eng, 'aa', { budget: 6, limits: { timeCapMs: 0 } });
  assert.strictEqual(cut.summary.truncated, true);
  assert.strictEqual(cut.summary.unproved, 3);
  assert.strictEqual(cut.summary.playedOut, false);
  assert.strictEqual(cut.summary.guaranteed, false);
  assert.strictEqual(cut.summary.strategyFits, false);
  assert.strictEqual(cut.summary.provedImpossible, false);
  assert.strictEqual(cut.summary.overBudget, 0);
  cut.depths.forEach(function (d) {
    assert.strictEqual(d.proved, false);
    assert.strictEqual(d.reason, 'cut');
  });
});

check('a shortlist policy that exceeds n is not a proof no line exists', function () {
  const eng = packOf(TRAP_ANSWERS, TRAP_GUESSES);
  const rough = build(eng, 'abc', {
    budget: 5, hard: 'wordle', policy: 'worst', limits: { exactSet: 0 }
  });
  assertAccounting(rough);
  assert.strictEqual(rough.summary.policyApprox, true);
  assert.strictEqual(rough.summary.playedOut, true);
  assert.strictEqual(rough.summary.maxDepth, 5);
  assert.strictEqual(rough.summary.strategyFits, true);
  assert.strictEqual(rough.summary.guaranteed, false);
  assert.strictEqual(rough.summary.provedImpossible, false);

  const over = build(eng, 'abc', {
    budget: 4, hard: 'wordle', policy: 'worst', limits: { exactSet: 0 }
  });
  assert.ok(over.summary.overBudget >= 1);
  assert.strictEqual(over.summary.policyApprox, true);
  assert.strictEqual(over.summary.provedImpossible, false);
  assert.strictEqual(over.summary.guaranteed, false);

  const easy = build(eng, 'abc', {
    budget: 4, hard: 'off', policy: 'worst', limits: { exactSet: 0 }
  });
  assert.strictEqual(easy.summary.maxDepth, 3);
  assert.strictEqual(easy.summary.strategyFits, true);
  assert.strictEqual(easy.summary.policyApprox, true);
  assert.strictEqual(easy.summary.guaranteed, false);
  const famPat = eng.pattern(eng.tokens[eng.keyIdx.get('abc')], eng.tokens[eng.keyIdx.get('abx')]);
  const fam = easy.root.children.filter(function (ch) { return ch.pat === famPat; })[0];
  assert.strictEqual(eng.keys[fam.node.guess], 'xyw');
});

check('steps policy on the trap still reports expected guesses', function () {
  const eng = packOf(TRAP_ANSWERS, TRAP_GUESSES);
  const tree = build(eng, 'abc', { budget: 4, hard: 'wordle', policy: 'steps' });
  assertAccounting(tree);
  assert.strictEqual(tree.summary.policy, 'steps');
  assert.strictEqual(tree.summary.maxDepth, 5);
  assert.strictEqual(tree.summary.overBudget, 1);
  assert.strictEqual(tree.summary.provedImpossible, false);
  assert.ok(tree.summary.expected > 1 && tree.summary.expected < 5);
  const map = byKey(eng, tree);
  assert.strictEqual(map.abw.depth, 5);
});

check('opener scan keeps quick-pick order and skips missing words', function () {
  const openers = ['slate', 'tarps', 'crane', 'cramp', 'trace'];
  const has = new Set(['crane', 'slate', 'later', 'aa', 'bb', 'zz']);
  const plan = Core.planOpenerScan({
    openers: openers,
    has: function (w) { return has.has(w); },
    remaining: ['crane', 'slate', 'aa', 'bb'],
    dict: ['zz', 'crane'],
    extraMaxRemaining: 16,
    extraCap: 40
  });
  assert.deepStrictEqual(plan.picks, ['slate', 'crane']);
  assert.deepStrictEqual(plan.extra, ['aa', 'bb', 'zz']);
  assert.deepStrictEqual(plan.all, ['slate', 'crane', 'aa', 'bb', 'zz']);
  assert.strictEqual(plan.continued, true);
});

check('opener scan does not walk the dictionary when the list is long', function () {
  const words = [];
  for (let i = 0; i < 17; i++) words.push('w' + i);
  const plan = Core.planOpenerScan({
    openers: ['slate', 'slate', 'missing', 'tarps'],
    has: function (w) { return w === 'slate' || w === 'tarps' || w.indexOf('w') === 0; },
    remaining: words,
    dict: ['probe'],
    extraMaxRemaining: 16,
    extraCap: 40
  });
  assert.deepStrictEqual(plan.picks, ['slate', 'tarps']);
  assert.deepStrictEqual(plan.extra, []);
  assert.strictEqual(plan.continued, false);
  assert.deepStrictEqual(plan.all, ['slate', 'tarps']);
});

check('expected information is the entropy of feedback buckets', function () {
  const eng = packOf(['aa', 'ab', 'ba'], ['cc']);
  const rem = Int32Array.from(eng.knownIdx);
  const pool = Int32Array.from([eng.keyIdx.get('aa'), eng.keyIdx.get('cc')]);
  const scores = Core.rankByInformation({
    U: eng.U, L: 2, K: eng.syms.length, rule: 'wordle', rem: rem, pool: pool
  });
  const by = {};
  scores.forEach(function (s) { by[eng.keys[s.idx]] = s.ent; });
  // aa separates all three answers. cc leaves one gray bucket.
  assert.ok(Math.abs(by.aa - Math.log2(3)) < 1e-9, by.aa);
  assert.ok(Math.abs(by.cc) < 1e-12, by.cc);
  assert.ok(by.aa > by.cc);
});

check('tied information keeps the earlier candidate', function () {
  const eng = packOf(['slate', 'crane'], []);
  const rem = Int32Array.from(eng.knownIdx);
  const pool = Int32Array.from(eng.knownIdx);
  const scores = Core.rankByInformation({
    U: eng.U, L: 5, K: eng.syms.length, rule: 'wordle', rem: rem, pool: pool
  });
  const chosen = Core.chooseOpenerList({
    declared: false,
    scores: scores.map(function (s) {
      return {
        word: eng.keys[s.idx],
        bits: s.ent,
        cand: s.cand,
        exp: s.exp,
        i: Array.prototype.indexOf.call(pool, s.idx)
      };
    })
  });
  assert.strictEqual(chosen.source, 'generated');
  assert.deepStrictEqual(chosen.words, ['slate', 'crane']);
  scores.forEach(function (s) { assert.ok(Math.abs(s.ent - 1) < 1e-9, s.ent); });
});

check('an authored opener list keeps its order', function () {
  const chosen = Core.chooseOpenerList({
    declared: true,
    authored: ['slate', 'tarps', 'crane'],
    scores: [
      { word: 'crane', bits: 9, cand: 1, exp: 1, i: 0 },
      { word: 'slate', bits: 1, cand: 1, exp: 1, i: 1 }
    ]
  });
  assert.deepStrictEqual(chosen.words, ['slate', 'tarps', 'crane']);
  assert.strictEqual(chosen.source, 'pack');
  const generated = Core.chooseOpenerList({
    declared: false,
    scores: [
      { word: 'low', bits: 0.2, i: 0 },
      { word: 'high', bits: 3, i: 1 },
      { word: 'mid', bits: 1, i: 2 },
      { word: 'also', bits: 0.4, i: 3 }
    ],
    limit: 2
  });
  assert.deepStrictEqual(generated.words, ['high', 'mid']);
  assert.strictEqual(generated.source, 'generated');
  const emptyAuthored = Core.chooseOpenerList({
    declared: true,
    authored: [],
    scores: [{ word: 'high', bits: 3, i: 0 }]
  });
  assert.deepStrictEqual(emptyAuthored.words, []);
  assert.strictEqual(emptyAuthored.source, 'pack');
});

check('opener candidates are capped by the score budget', function () {
  assert.deepStrictEqual(Core.boundOpenerCandidates(['a', 'b', 'c', 'd'], 10, 25), ['a', 'b']);
  assert.deepStrictEqual(Core.boundOpenerCandidates(['a', 'b'], 397, Core.OPENER_SCORE_CELLS), ['a', 'b']);
  assert.strictEqual(Core.OPENER_GENERATED_CAP, 10);
});

function alphabetEntries(eng) {
  return Pack.alphabetTokens(eng.pack).map(function (token) {
    var id = eng.symId.has(token) ? eng.symId.get(token) : eng.symIdOf(token);
    return { token: token, id: id };
  });
}

check('any-mode guesses are a bounded sample, not alphabet^length', function () {
  const eng = packOf(['aa', 'bb', 'cc'], []);
  const skip = new Set(['aa', 'bb', 'cc']);
  const once = Core.generateAnyGuesses({
    U: eng.U, L: 2, rem: eng.knownIdx, alphabet: alphabetEntries(eng),
    skip: function (w) { return skip.has(w); }, cap: 30
  });
  const twice = Core.generateAnyGuesses({
    U: eng.U, L: 2, rem: eng.knownIdx, alphabet: alphabetEntries(eng),
    skip: function (w) { return skip.has(w); }, cap: 30
  });
  assert.ok(once.guesses.length > 0 && once.guesses.length <= 30, once.guesses.length);
  assert.deepStrictEqual(once.guesses.map(function (g) { return g.word; }), twice.guesses.map(function (g) { return g.word; }));
  once.guesses.forEach(function (g) {
    assert.strictEqual(g.word.length, 2, g.word);
    assert.ok(!skip.has(g.word), g.word);
    assert.strictEqual(g.ids.length, 2);
  });
  assert.ok(once.guesses.some(function (g) { return g.word === 'ab' || g.word === 'ba'; }), once.guesses.map(function (g) { return g.word; }).join(','));
  const capped = Core.generateAnyGuesses({
    U: eng.U, L: 2, rem: eng.knownIdx, alphabet: alphabetEntries(eng), cap: 3
  });
  assert.ok(capped.guesses.length <= 3);
  assert.strictEqual(capped.capped, true);
  assert.ok(Core.anyGuessCap(397) <= Core.ANY_GUESS_CAP);
  assert.ok(Core.anyGuessCap(397) < Math.pow(26, 5));
});

check('any-mode sample includes the other case of a letter', function () {
  const pack = Pack.fromCustom({
    length: 2, alphabet: 'abAB', caseInsensitive: false, tokens: false, rule: 'wordle'
  });
  const eng = Engine.create(pack, { answers: 'aa\nbb\n', guesses: '' });
  const gen = Core.generateAnyGuesses({
    U: eng.U, L: 2, rem: eng.knownIdx, alphabet: alphabetEntries(eng),
    skip: function (w) { return eng.keyIdx.has(w); }
  });
  const words = gen.guesses.map(function (g) { return g.word; });
  assert.ok(words.some(function (w) { return /[A-Z]/.test(w) && /[a-z]/.test(w); }), words.slice(0, 20).join(','));
});

check('a non-listed guess outranks the answers when it splits them', function () {
  const eng = packOf(['aa', 'bb', 'cc'], []);
  const gen = Core.generateAnyGuesses({
    U: eng.U, L: 2, rem: eng.knownIdx, alphabet: alphabetEntries(eng),
    skip: function (w) { return eng.keyIdx.has(w); }, cap: 40
  });
  const scores = Core.scoreGuessWords({
    U: eng.U, L: 2, K: eng.syms.length, rule: 'wordle',
    rem: Int32Array.from(eng.knownIdx), pool: eng.knownIdx, extra: gen.guesses, keys: eng.keys
  });
  assert.ok(scores.length > 3);
  assert.ok(!eng.keyIdx.has(scores[0].word), scores[0].word);
  assert.ok(Math.abs(scores[0].ent - Math.log2(3)) < 1e-9, scores[0].ent);
  const listed = scores.filter(function (s) { return eng.keyIdx.has(s.word); })[0];
  assert.ok(scores[0].ent > listed.ent);
  const chosen = Core.chooseOpenerList({
    declared: false,
    scores: scores.map(function (s, i) {
      return { word: s.word, bits: s.ent, cand: s.cand, exp: s.exp, i: i };
    })
  });
  assert.ok(!eng.keyIdx.has(chosen.words[0]), chosen.words[0]);
});

check('a tree can open on a guess that is not in the lists', function () {
  const eng = packOf(['aa', 'bb', 'cc'], []);
  const gen = Core.generateAnyGuesses({
    U: eng.U, L: 2, rem: eng.knownIdx, alphabet: alphabetEntries(eng),
    skip: function (w) { return eng.keyIdx.has(w); }, cap: 40
  });
  const ab = gen.guesses.filter(function (g) { return g.word === 'ab'; })[0];
  assert.ok(ab, 'ab missing');
  const big = new Uint16Array(eng.U.length + 2);
  big.set(eng.U);
  big[eng.U.length] = ab.ids[0];
  big[eng.U.length + 1] = ab.ids[1];
  const tree = Core.buildOpenerTree({
    U: big,
    L: 2,
    K: eng.syms.length,
    rule: 'wordle',
    rem: eng.knownIdx,
    guessIdx: eng.guessIdx.concat([eng.nWords]),
    guessMode: 'any',
    opener: eng.nWords,
    openerIds: ab.ids,
    budget: 2,
    policy: 'worst',
    hard: 'off'
  });
  assert.strictEqual(tree.summary.playedOut, true);
  assert.strictEqual(tree.summary.maxDepth, 2);
  assert.strictEqual(tree.summary.opener, eng.nWords);
  assert.strictEqual(tree.summary.openerOutsidePool, false);
});

check('opener scan caps the extra starters', function () {
  const plan = Core.planOpenerScan({
    openers: [],
    has: function () { return true; },
    remaining: ['aa'],
    dict: ['bb', 'cc', 'dd', 'ee'],
    extraMaxRemaining: 16,
    extraCap: 3
  });
  assert.deepStrictEqual(plan.all, ['aa', 'bb', 'cc']);
  assert.strictEqual(plan.continued, true);
});

try {
  console.log(passed + ' passed');
} catch (err) {
  console.error(err);
  process.exit(1);
}
