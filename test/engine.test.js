'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const Core = require(path.join(root, 'src/core.js'));
const Pack = require(path.join(root, 'src/pack.js'));
const Engine = require(path.join(root, 'src/engine.js'));
const Renderers = require(path.join(root, 'src/renderers.js'));

let passed = 0;
const pending = [];
function check(name, fn) {
  const out = fn();
  const done = Promise.resolve(out).then(function () {
    passed++;
    console.log('ok', name);
  });
  pending.push(done);
}

function digits(guess, secret, rule) {
  const syms = [];
  const id = new Map();
  function sid(ch) {
    if (!id.has(ch)) { id.set(ch, syms.length); syms.push(ch); }
    return id.get(ch);
  }
  const g = Uint16Array.from(Array.from(guess).map(sid));
  const a = Uint16Array.from(Array.from(secret).map(sid));
  const counts = new Int16Array(syms.length + 2);
  const pat = Core.feedback(g, 0, a, 0, guess.length, rule || 'wordle', counts, Core.pow3(guess.length));
  return Pack.patToDigits(pat, guess.length);
}

function tiny(opts) {
  const pack = Pack.fromCustom(Object.assign({
    length: 5,
    alphabet: 'abcdefghijklmnopqrstuvwxyz',
    caseInsensitive: true,
    tokens: false,
    rule: 'wordle'
  }, opts || {}));
  return Engine.create(pack, {
    answers: opts && opts.answers != null ? opts.answers : 'aaaaa\naaaab\n',
    guesses: opts && opts.guesses != null ? opts.guesses : 'aaaaa\naaaab\naaaac\nbbbbb\n'
  });
}

function keys(eng, idxs) {
  return idxs.map(function (i) { return eng.keys[i]; }).sort();
}

check('wordle feedback handles greens before extra copies', function () {
  assert.deepStrictEqual(digits('abcde', 'abcde'), [2, 2, 2, 2, 2]);
  assert.deepStrictEqual(digits('slate', 'crane'), [0, 0, 2, 0, 2]);
  assert.deepStrictEqual(digits('aa', 'ab'), [2, 0]);
  assert.deepStrictEqual(digits('aa', 'ba'), [0, 2]);
  assert.deepStrictEqual(digits('aaa', 'abc'), [2, 0, 0]);
  assert.deepStrictEqual(digits('speed', 'abide'), [0, 0, 1, 0, 1]);
  assert.deepStrictEqual(digits('abab', 'baba'), [1, 1, 1, 1]);
});

check('simple feedback marks any present letter', function () {
  assert.deepStrictEqual(digits('aaa', 'abc', 'simple'), [2, 1, 1]);
  assert.deepStrictEqual(digits('aaa', 'abc', 'wordle'), [2, 0, 0]);
});

check('core rank prefers the requested metric', function () {
  const scores = [
    { idx: 0, exp: 2, worst: 3, splits: 2, ent: 1, cand: 0 },
    { idx: 1, exp: 2, worst: 1, splits: 4, ent: 0.5, cand: 1 }
  ];
  assert.strictEqual(Core.rank(scores.slice(), 'minimax', 1)[0].idx, 1);
  assert.strictEqual(Core.rank(scores.slice(), 'splits', 1)[0].idx, 1);
  assert.strictEqual(Core.rank(scores.slice(), 'entropy', 1)[0].idx, 0);
});

check('layers and guess modes on one pack', function () {
  const eng = tiny();
  assert.strictEqual(eng.nKnown, 2);
  assert.strictEqual(eng.nWords, 4);
  assert.deepStrictEqual(keys(eng, eng.theoreticalIdx), ['aaaaa', 'aaaab', 'aaaac', 'bbbbb']);

  const gray = eng.makeClue('bbbbb', [0, 0, 0, 0, 0]);
  const parts = eng.partition([gray]);
  assert.deepStrictEqual(keys(eng, parts.known), ['aaaaa']);
  assert.deepStrictEqual(keys(eng, parts.theoretical), ['aaaaa', 'aaaac']);
  assert.deepStrictEqual(keys(eng, eng.activeRemaining('known', parts)), ['aaaaa']);
  assert.deepStrictEqual(keys(eng, eng.activeRemaining('theoretical', parts)), ['aaaaa', 'aaaac']);

  const hard = eng.buildPool({
    guessMode: 'hard', valid: 'both', hard: 'off', ansOnly: false,
    remaining: parts.known, clues: [gray], max: 100
  });
  assert.deepStrictEqual(keys(eng, hard.pool), ['aaaaa', 'aaaac']);

  const answers = eng.buildPool({
    guessMode: 'answersOnly', valid: 'both', hard: 'off', ansOnly: true,
    remaining: parts.known, clues: [gray], max: 100
  });
  assert.deepStrictEqual(keys(eng, answers.pool), ['aaaaa']);

  const dict = eng.buildPool({
    guessMode: 'dictionary', valid: 'both', hard: 'off', ansOnly: false,
    remaining: parts.known, clues: [gray], max: 100
  });
  assert.strictEqual(dict.pool.length, 4);

  const listedOnly = eng.buildPool({
    guessMode: 'dictionary', valid: 'answers', hard: 'off', ansOnly: false,
    remaining: parts.known, clues: [gray], max: 100
  });
  assert.deepStrictEqual(keys(eng, listedOnly.pool), ['aaaaa', 'aaaab']);

  const green = eng.makeClue('aaaaa', [2, 2, 2, 2, 2]);
  const wordleHard = eng.buildPool({
    guessMode: 'dictionary', valid: 'both', hard: 'wordle', ansOnly: false,
    remaining: eng.partition([green]).known, clues: [green], max: 100
  });
  assert.deepStrictEqual(keys(eng, wordleHard.pool), ['aaaaa']);

  assert.strictEqual(eng.rules.consistent(
    Pack.parseWord('bbbbb', eng.pack),
    gray.clue,
    Pack.parseWord('aaaaa', eng.pack),
    eng
  ), true);
  assert.strictEqual(eng.rules.consistent(
    Pack.parseWord('bbbbb', eng.pack),
    gray.clue,
    Pack.parseWord('aaaab', eng.pack),
    eng
  ), false);
  assert.strictEqual(eng.consistentAll(Pack.parseWord('aaaac', eng.pack), [
    { guess: Pack.parseWord('bbbbb', eng.pack), clue: gray.clue }
  ]), true);
});

check('preferred layer falls back when no known solution fits', function () {
  const eng = tiny({ answers: 'aaaaa\n', guesses: 'aaaaa\nbbbbb\n' });
  const clue = eng.makeClue('aaaaa', [0, 0, 0, 0, 0]);
  const parts = eng.partition([clue]);
  assert.deepStrictEqual(parts.known, []);
  assert.deepStrictEqual(keys(eng, parts.theoretical), ['bbbbb']);
  assert.deepStrictEqual(keys(eng, eng.activeRemaining('preferred', parts)), ['bbbbb']);
  const pool = eng.buildPool({
    guessMode: 'answersOnly', valid: 'both', hard: 'off', ansOnly: true,
    remaining: eng.activeRemaining('preferred', parts), clues: [clue], max: 50
  });
  assert.deepStrictEqual(keys(eng, pool.pool), ['bbbbb']);
});

check('consistentAll requires every previous clue', function () {
  const eng = tiny({
    answers: 'aaaaa\naaaab\naaaac\n',
    guesses: 'aaaaa\naaaab\naaaac\n'
  });
  const c1 = eng.makeClue('bbbbb', [0, 0, 0, 0, 0]);
  const c2 = eng.makeClue('aaaac', [2, 2, 2, 2, 0]);
  const parts = eng.partition([c1, c2]);
  // c1 drops aaaab (its b would go green). c2 drops aaaac (its c would go green).
  assert.deepStrictEqual(keys(eng, parts.known), ['aaaaa']);
  assert.strictEqual(eng.consistentAllIndex(eng.keyIdx.get('aaaab'), [c1]), false);
  assert.strictEqual(eng.consistentAllIndex(eng.keyIdx.get('aaaac'), [c1, c2]), false);
  assert.strictEqual(eng.consistentAllIndex(eng.keyIdx.get('aaaaa'), [c1, c2]), true);
});

check('clue text and token delimiters are I/O only', function () {
  const pack = Pack.fromCustom({
    length: 5, alphabet: 'abcdefghijklmnopqrstuvwxyz', caseInsensitive: true, rule: 'wordle'
  });
  assert.deepStrictEqual(Pack.parseClue('rgyrr', pack).digits, [0, 2, 1, 0, 0]);
  assert.deepStrictEqual(Pack.parseClue('🟩🟨⬛⬛⬛', pack).digits, [2, 1, 0, 0, 0]);
  assert.strictEqual(Pack.parseClue('rg', pack), null);

  const cards = Pack.fromCustom({
    length: 3, tokens: true, caseInsensitive: false, alphabet: '', rule: 'wordle'
  });
  assert.deepStrictEqual(Pack.parseWord('AS KH 10D', cards), ['AS', 'KH', '10D']);
  assert.strictEqual(Pack.formatWord(['AS', 'KH', '10D'], cards), 'AS KH 10D');
  const hand = Engine.create(cards, { answers: 'AS KH 10D\nQS QH 2C\n', guesses: '' });
  assert.strictEqual(hand.nKnown, 2);
  assert.deepStrictEqual(hand.feedbackDigits('AS KH 10D', 'QS QH 2C'), [0, 0, 0]);

  const fixed = Pack.fromCustom({
    length: 3, delimiter: 'fixed', delimiterValue: '-', caseInsensitive: false, alphabet: '', rule: 'wordle'
  });
  assert.deepStrictEqual(Pack.parseWord('AS-KH-10', fixed), ['AS', 'KH', '10']);
  assert.strictEqual(Pack.formatWord(['AS', 'KH', '10'], fixed), 'AS-KH-10');
});

check('sandboxed wordle script matches builtin feedback', function () {
  const source = fs.readFileSync(path.join(root, 'src/packs/rules/wordle.js'), 'utf8');
  const rules = Pack.evalRules(source);
  const scripted = tiny({ rulesImpl: rules, answers: 'crane\nslate\n', guesses: 'crane\nslate\nabide\n' });
  const builtin = tiny({ answers: 'crane\nslate\n', guesses: 'crane\nslate\nabide\n' });
  assert.deepStrictEqual(scripted.feedbackDigits('slate', 'crane'), builtin.feedbackDigits('slate', 'crane'));
  assert.deepStrictEqual(scripted.feedbackDigits('slate', 'crane'), [0, 0, 2, 0, 2]);
  const clue = scripted.makeClue('slate', [0, 0, 2, 0, 2]);
  assert.strictEqual(rules.consistent(
    Pack.parseWord('slate', scripted.pack),
    clue.clue,
    Pack.parseWord('crane', scripted.pack),
    scripted
  ), true);
  assert.throws(function () { Pack.evalRules('exports.validGuess = function () { return true; };'); });
});

check('renderer ids cover the site libraries', function () {
  assert.ok(Renderers.ids.tokens.indexOf('tiles/letters') >= 0);
  assert.ok(Renderers.ids.tokens.indexOf('tiles/cards') >= 0);
  assert.ok(Renderers.ids.tokens.indexOf('tiles/dungleon') >= 0);
  assert.ok(Renderers.ids.clues.indexOf('clues/wordle-gyb') >= 0);
  assert.ok(Renderers.ids.clues.indexOf('clues/arrows-lr') >= 0);
  assert.ok(Renderers.ids.clues.indexOf('clues/mastermind-pips') >= 0);
  const html = Renderers.tiles('tiles/cards', ['AS', '10D'], [2, 0]);
  assert.ok(html.indexOf('tiles cards') >= 0);
  assert.ok(html.indexOf('>AS<') >= 0);
  assert.strictEqual(Renderers.clueCode('clues/wordle-gyb', [0, 2, 1, 0, 0], 'gyr'), 'rgyrr');
  assert.strictEqual(Renderers.clueCode('clues/mastermind-pips', [2, 2, 1, 0], 'GYB'), '2B1W');
});

check('english pack JSON is the current 4–8 lists', function () {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/packs/wordle-en.json'), 'utf8'));
  assert.strictEqual(manifest.rules, 'builtin:wordle');
  assert.strictEqual(manifest.pools.theoretical, 'guessList');
  assert.strictEqual(manifest.clueShape, 'perSlot');
  assert.deepStrictEqual(manifest.variants.map(function (v) { return v.length; }), [4, 5, 6, 7, 8]);

  const sketch = JSON.parse(fs.readFileSync(path.join(root, 'src/packs/mastermind-sketch.json'), 'utf8'));
  assert.strictEqual(sketch.status, 'sketch');
  assert.strictEqual(sketch.clueShape, 'whole');
  assert.strictEqual(sketch.clueRenderer, 'clues/mastermind-pips');

  const variant = manifest.variants.filter(function (v) { return v.id === 'wordle-en-5'; })[0];
  const pack = Pack.normalize(manifest, variant);
  const answers = fs.readFileSync(path.join(root, 'src/packs', variant.knownSolutions), 'utf8');
  const guesses = fs.readFileSync(path.join(root, 'src/packs', variant.guessList), 'utf8');
  const eng = Engine.create(pack, { answers: answers, guesses: guesses });
  assert.strictEqual(eng.nKnown, 2400);
  assert.strictEqual(eng.nWords, 8636);
  assert.strictEqual(eng.theoreticalIdx.length, 8636);
  assert.strictEqual(eng.dup, 2400);
  assert.strictEqual(eng.rej, 0);
  assert.ok(eng.flags.every(function (f) { return !f.known || f.theoretical; }));
  assert.deepStrictEqual(eng.feedbackDigits('slate', 'crane'), [0, 0, 2, 0, 2]);
  assert.strictEqual(eng.encode('SLATE').key, 'slate');
  assert.ok(eng.encode('12345').err);

  const clue = eng.makeClue('slate', [0, 0, 2, 0, 2]);
  const parts = eng.partition([clue]);
  assert.ok(parts.known.length < 2400);
  assert.ok(parts.known.indexOf(eng.keyIdx.get('crane')) >= 0);
  assert.ok(parts.known.indexOf(eng.keyIdx.get('slate')) < 0);
  assert.ok(parts.known.indexOf(eng.keyIdx.get('abbey')) < 0);
  assert.ok(parts.theoretical.length > parts.known.length);

  const replayed = eng.replay([clue], 'known');
  assert.strictEqual(clue.afterKnown, parts.known.length);
  assert.strictEqual(clue.afterTheo, parts.theoretical.length);
  assert.strictEqual(replayed.known.length, parts.known.length);
});

check('script: rules load through Pack.loadRules', function () {
  var manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/packs/wordle-en.json'), 'utf8'));
  var pack = Pack.normalize(manifest, manifest.variants[1]);
  pack.rules = 'script:rules/wordle.js';
  return Pack.loadRules(pack, function (rel) {
    assert.strictEqual(rel, 'rules/wordle.js');
    return Promise.resolve(fs.readFileSync(path.join(root, 'src/packs', rel), 'utf8'));
  }).then(function (rules) {
    pack.rulesImpl = rules;
    var eng = Engine.create(pack, { answers: 'crane\nslate\n', guesses: 'crane\nslate\ntrace\n' });
    assert.deepStrictEqual(eng.feedbackDigits('slate', 'crane'), [0, 0, 2, 0, 2]);
    assert.strictEqual(eng.rules.validGuess(Pack.parseWord('trace', pack), eng), true);
    assert.strictEqual(eng.rules.validGuess(Pack.parseWord('zzzzz', pack), eng), false);
  });
});

function mini(len, answers, guesses) {
  const pack = Pack.fromCustom({
    length: len,
    alphabet: 'abcdefghijklmnopqrstuvwxyz',
    caseInsensitive: true,
    tokens: false,
    rule: 'wordle'
  });
  return Engine.create(pack, { answers: answers.join('\n'), guesses: guesses.join('\n') });
}

function dictOf(eng) {
  const d = new Int32Array(eng.nWords);
  for (let i = 0; i < eng.nWords; i++) d[i] = i;
  return d;
}

function scoreSteps(eng, rem, pool, opts) {
  const isCand = new Uint8Array(eng.nWords);
  rem.forEach(function (i) { isCand[i] = 1; });
  const scores = Core.scorePool(
    eng.U, eng.pack.length, eng.syms.length, eng.feedbackRule,
    Int32Array.from(rem), Int32Array.from(pool), isCand
  );
  Core.attachExpectedSteps(
    scores, eng.U, eng.pack.length, eng.syms.length, eng.feedbackRule,
    Int32Array.from(rem), Int32Array.from(pool), opts || { guessMode: 'dictionary', hard: 'off', clues: [], dict: dictOf(eng) }
  );
  const by = {};
  scores.forEach(function (s) { by[eng.keys[s.idx]] = s; });
  return by;
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, (label || '') + ' ' + actual + ' !~ ' + expected);
}

check('steps mode sorts by expected steps and leaves unscored rows last', function () {
  const scores = [
    { idx: 0, exp: 1, worst: 1, splits: 4, ent: 2, cand: 0, steps: 3 },
    { idx: 1, exp: 5, worst: 5, splits: 2, ent: 0.2, cand: 1, steps: 2.1 },
    { idx: 2, exp: 0, worst: 0, splits: 1, ent: 0, cand: 1, steps: null }
  ];
  const ranked = Core.rank(scores.map(function (s) { return Object.assign({}, s); }), 'steps', 3);
  assert.strictEqual(ranked[0].idx, 1);
  assert.strictEqual(ranked[2].idx, 2);
});

check('expected steps matches a hand-checked tree', function () {
  // Length 2. Answers ab, ac, ba. Guess ab:
  //   ab → GG (solved, contributes 1)
  //   ac → GB (singleton, +1)
  //   ba → YY (singleton, +1)
  //   steps = (1 + 2 + 2) / 3 = 5/3
  // One-ply expected remaining is (1+1)/3 = 2/3, so the column is not a rename of exp.
  const triple = mini(2, ['ab', 'ac', 'ba'], ['ab', 'ac', 'ba']);
  assert.deepStrictEqual(triple.feedbackDigits('ab', 'ac'), [2, 0]);
  assert.deepStrictEqual(triple.feedbackDigits('ab', 'ba'), [1, 1]);
  const tripleScores = scoreSteps(triple, triple.knownIdx, triple.guessIdx);
  near(tripleScores.ab.steps, 5 / 3, 'ab separates three');
  assert.strictEqual(tripleScores.ab.approx, 0);
  assert.ok(Math.abs(tripleScores.ab.steps - tripleScores.ab.exp) > 0.2);

  // One secret: guessing it costs 1. Two secrets: guessing either costs 1.5.
  // zz matches both as BB, so it wastes a guess and then the pair still costs 1.5.
  const pair = mini(2, ['aa', 'ab'], ['aa', 'ab', 'zz']);
  const one = mini(2, ['aa'], ['aa', 'zz']);
  near(scoreSteps(one, one.knownIdx, one.guessIdx).aa.steps, 1, 'solved in 1');
  near(scoreSteps(one, one.knownIdx, one.guessIdx).zz.steps, 2, 'miss then solve');
  const pairScores = scoreSteps(pair, pair.knownIdx, pair.guessIdx);
  near(pairScores.aa.steps, 1.5, 'pair');
  near(pairScores.zz.steps, 2.5, 'wasted guess');

  // Disjoint answers ab, cd, ef, gh. Bridge ae is not an answer.
  //   ae → {ab}, {ef}, {cd, gh}
  //   steps = 1 + (1/4)*1 + (1/4)*1 + (1/2)*1.5 = 2.25
  //   ab → solved + {cd, ef, gh} lumped. That triple is 2 (no guess separates it),
  //   so ab scores 1 + (3/4)*2 = 2.5
  const quad = mini(2, ['ab', 'cd', 'ef', 'gh'], ['ab', 'cd', 'ef', 'gh', 'ae']);
  assert.deepStrictEqual(quad.feedbackDigits('ae', 'ab'), [2, 0]);
  assert.deepStrictEqual(quad.feedbackDigits('ae', 'ef'), [0, 1]);
  assert.deepStrictEqual(quad.feedbackDigits('ae', 'cd'), [0, 0]);
  assert.deepStrictEqual(quad.feedbackDigits('ab', 'cd'), [0, 0]);
  assert.deepStrictEqual(quad.feedbackDigits('ab', 'ef'), [0, 0]);
  const quadScores = scoreSteps(quad, quad.knownIdx, quad.guessIdx);
  near(quadScores.ae.steps, 2.25, 'bridge');
  near(quadScores.ab.steps, 2.5, 'answer opener');
  near(quadScores.cd.steps, 2.5, 'answer opener cd');
  assert.strictEqual(quadScores.ae.approx, 0);
  assert.strictEqual(quadScores.ab.approx, 0);
  const ranked = Core.rank(Object.keys(quadScores).map(function (k) { return quadScores[k]; }), 'steps', 1);
  assert.strictEqual(quad.keys[ranked[0].idx], 'ae');

  // Same first guess, different next-guess pool.
  // Answers ab, cd, ef, gh, zz. zz leaves the disjoint quad (all BB).
  // Dictionary may play ae next (2.25): 1 + (4/5)*(9/4) = 14/5.
  // Answers only cannot: 1 + (4/5)*(5/2) = 3.
  const five = mini(2, ['ab', 'cd', 'ef', 'gh', 'zz'], ['ab', 'cd', 'ef', 'gh', 'zz', 'ae']);
  const rem5 = five.knownIdx.slice();
  const dictSteps = scoreSteps(five, rem5, five.guessIdx, {
    guessMode: 'dictionary', hard: 'off', clues: [], dict: dictOf(five)
  });
  const ansPool = five.buildPool({
    guessMode: 'answersOnly', valid: 'both', hard: 'off', ansOnly: true,
    remaining: rem5, clues: [], max: 50
  });
  assert.deepStrictEqual(keys(five, ansPool.pool), ['ab', 'cd', 'ef', 'gh', 'zz']);
  const ansSteps = scoreSteps(five, rem5, ansPool.pool, {
    guessMode: 'answersOnly', hard: 'off', clues: [], dict: null
  });
  near(dictSteps.zz.steps, 14 / 5, 'zz with bridge continuation');
  near(ansSteps.zz.steps, 3, 'zz answers-only continuation');
  assert.strictEqual(dictSteps.zz.approx, 0);
  assert.strictEqual(ansSteps.zz.approx, 0);
});

check('wordle hard changes expected steps of the same guess', function () {
  // Answers ab, ac, ad, ae, af all share a leading a.
  // Clue ax → GB keeps all five and forces Wordle hard to keep that green.
  // Guessing af leaves {ab, ac, ad, ae}.
  //   bc splits that quad 1+1+2 and scores 2.25, but it breaks the green.
  //   A legal answer leaves a lumped triple (itself 2) and scores 2.5.
  //   af therefore costs 1+(4/5)*2.25 = 2.8 off hard mode, and 1+(4/5)*2.5 = 3 on it.
  const eng = mini(2, ['ab', 'ac', 'ad', 'ae', 'af'], ['ab', 'ac', 'ad', 'ae', 'af', 'ax', 'bc']);
  const clue = eng.makeClue('ax', [2, 0]);
  const rem = eng.partition([clue]).known.slice();
  assert.deepStrictEqual(keys(eng, rem), ['ab', 'ac', 'ad', 'ae', 'af']);
  assert.strictEqual(eng.wordleHardOk(eng.keyIdx.get('bc'), [clue]), false);
  assert.strictEqual(eng.wordleHardOk(eng.keyIdx.get('af'), [clue]), true);
  assert.deepStrictEqual(eng.feedbackDigits('bc', 'ab'), [1, 0]);
  assert.deepStrictEqual(eng.feedbackDigits('bc', 'ac'), [0, 2]);
  assert.deepStrictEqual(eng.feedbackDigits('bc', 'ad'), [0, 0]);
  assert.deepStrictEqual(eng.feedbackDigits('af', 'ab'), [2, 0]);
  const clues = [{ ids: clue.ids, pat: clue.pat, digits: clue.digits }];
  const off = scoreSteps(eng, rem, eng.guessIdx, {
    guessMode: 'dictionary', hard: 'off', clues: clues, dict: dictOf(eng)
  });
  const on = scoreSteps(eng, rem, eng.guessIdx, {
    guessMode: 'dictionary', hard: 'wordle', clues: clues, dict: dictOf(eng)
  });
  near(off.af.steps, 1 + (4 / 5) * 2.25, 'af off hard');
  near(on.af.steps, 3, 'af on wordle hard');
  assert.strictEqual(off.af.approx, 0);
  assert.strictEqual(on.af.approx, 0);
  const legal = eng.buildPool({
    guessMode: 'dictionary', valid: 'both', hard: 'wordle', ansOnly: false,
    remaining: rem, clues: [clue], max: 50
  });
  assert.ok(keys(eng, legal.pool).indexOf('bc') < 0);
  assert.ok(keys(eng, legal.pool).indexOf('af') >= 0);
  const strict = eng.buildPool({
    guessMode: 'hard', valid: 'both', hard: 'strict', ansOnly: false,
    remaining: rem, clues: [clue], max: 50
  });
  assert.ok(keys(eng, strict.pool).indexOf('bc') < 0);
});

function oracleSteps(eng, answers, guesses) {
  const U = eng.U;
  const L = eng.pack.length;
  const counts = new Int16Array(eng.syms.length + 2);
  const pow3 = Core.pow3(L);
  const rule = eng.feedbackRule;
  let allGreen = 0;
  for (let i = 0; i < L; i++) allGreen += 2 * pow3[i];
  const memo = new Map();
  function fb(g, a) {
    return Core.feedback(U, g * L, U, a * L, L, rule, counts, pow3);
  }
  function E(set) {
    const sorted = set.slice().sort(function (a, b) { return a - b; });
    const key = sorted.join(',');
    if (memo.has(key)) return memo.get(key);
    if (sorted.length <= 1) { memo.set(key, sorted.length); return sorted.length; }
    let best = Infinity;
    for (let gi = 0; gi < guesses.length; gi++) {
      const g = guesses[gi];
      const groups = new Map();
      for (let ai = 0; ai < sorted.length; ai++) {
        const pat = fb(g, sorted[ai]);
        if (!groups.has(pat)) groups.set(pat, []);
        groups.get(pat).push(sorted[ai]);
      }
      if (groups.size === 1 && !groups.has(allGreen)) continue;
      let extra = 0;
      groups.forEach(function (members, pat) {
        if (pat === allGreen) return;
        extra += (members.length / sorted.length) * E(members);
      });
      if (1 + extra < best) best = 1 + extra;
    }
    memo.set(key, best);
    return best;
  }
  const out = {};
  const sortedAnswers = answers.slice().sort(function (a, b) { return a - b; });
  for (let gi = 0; gi < guesses.length; gi++) {
    const g = guesses[gi];
    const groups = new Map();
    for (let ai = 0; ai < sortedAnswers.length; ai++) {
      const pat = fb(g, sortedAnswers[ai]);
      if (!groups.has(pat)) groups.set(pat, []);
      groups.get(pat).push(sortedAnswers[ai]);
    }
    if (groups.size === 1 && !groups.has(allGreen)) {
      out[g] = 1 + E(sortedAnswers);
      continue;
    }
    let extra = 0;
    groups.forEach(function (members, pat) {
      if (pat === allGreen) return;
      extra += (members.length / sortedAnswers.length) * E(members);
    });
    out[g] = 1 + extra;
  }
  return out;
}

check('expected steps matches an independent tree on tiny packs', function () {
  function agree(eng) {
    const answers = eng.knownIdx.slice();
    const guesses = [];
    for (let i = 0; i < eng.nWords; i++) guesses.push(i);
    const oracle = oracleSteps(eng, answers, guesses);
    const got = scoreSteps(eng, answers, guesses, {
      guessMode: 'dictionary', hard: 'off', clues: [], dict: dictOf(eng),
      limits: { exactSet: 8, exactPool: 500, rankAllMax: 30, contPool: 500, nodeBeam: 8 }
    });
    guesses.forEach(function (g) {
      const key = eng.keys[g];
      near(got[key].steps, oracle[g], key);
      assert.strictEqual(got[key].approx, 0);
    });
  }
  agree(mini(2, ['ab', 'cd', 'ef', 'gh'], ['ab', 'cd', 'ef', 'gh', 'ae']));
  agree(mini(2, ['ab', 'ac', 'ba'], ['ab', 'ac', 'ba']));
  agree(mini(3, ['abc', 'abx', 'axy', 'zzz'], ['abc', 'abx', 'axy', 'zzz', 'aaa', 'bxz']));

  function randWord(rand, alpha) {
    let s = '';
    for (let i = 0; i < 3; i++) s += alpha[Math.floor(rand() * alpha.length)];
    return s;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  [2, 9, 21, 44].forEach(function (seed) {
    const rand = rng(seed);
    const alpha = 'abcdef';
    const seen = new Set();
    const answers = [];
    while (answers.length < 4) {
      const w = randWord(rand, alpha);
      if (seen.has(w)) continue;
      seen.add(w);
      answers.push(w);
    }
    const guesses = answers.slice();
    while (guesses.length < 7) {
      const w = randWord(rand, alpha);
      if (seen.has(w)) continue;
      seen.add(w);
      guesses.push(w);
    }
    agree(mini(3, answers, guesses));
  });
});

check('cut-down steps are an upper bound on the exact tree', function () {
  const eng = mini(2, ['ab', 'cd', 'ef', 'gh', 'ij', 'kl'], ['ab', 'cd', 'ef', 'gh', 'ij', 'kl', 'ae', 'xx']);
  const answers = eng.knownIdx.slice();
  const guesses = [];
  for (let i = 0; i < eng.nWords; i++) guesses.push(i);
  const oracle = oracleSteps(eng, answers, guesses);
  const got = scoreSteps(eng, answers, guesses, {
    guessMode: 'dictionary', hard: 'off', clues: [], dict: dictOf(eng),
    limits: { exactSet: 3, exactPool: 3, rankAllMax: 20, contPool: 3, nodeBeam: 1, beamExp: 20, beamEnt: 0, beamWorst: 0 }
  });
  let sawApprox = false;
  guesses.forEach(function (g) {
    const row = got[eng.keys[g]];
    assert.ok(row.steps + 1e-9 >= oracle[g], eng.keys[g] + ' ' + row.steps + ' < ' + oracle[g]);
    if (row.approx) sawApprox = true;
  });
  assert.ok(sawApprox);
});

check('steps limits in the UI match the search', function () {
  const lim = Core.stepsLimits;
  const phrase = 'Exact through ' + lim.exactSet + ' answers (at most ' + lim.exactPool +
    ' guesses tried at one of those nodes). A dictionary larger than ' + lim.shortlist +
    ' is cut to that many probes for the whole search, and the answers still in the set are always added back. Every guess in the pool is valued when at most ' +
    lim.rankAllMax + ' answers remain and the pool has at most ' + lim.rankAllPool +
    ' rows; above that, deepen a beam of ' + lim.beamExp + ' expected-remaining, ' + lim.beamEnt +
    ' entropy, and ' + lim.beamWorst + ' worst-case guesses. Larger sets continue with the top ' +
    lim.nodeBeam + ' one-ply pick' + (lim.nodeBeam === 1 ? '' : 's') + ' from ' + lim.contPool + ' candidates.';
  ['src/index.html', 'README.md', 'src/README.txt', 'docs/pack-format.md'].forEach(function (rel) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(text.indexOf(phrase) >= 0, rel + ' is missing the steps-limit sentence');
  });
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  assert.ok(html.indexOf('value="steps"') >= 0);
  assert.ok(html.indexOf('Fewest expected steps to solve') >= 0);
  assert.ok(html.indexOf('>Steps<') >= 0);
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8');
  assert.ok(app.indexOf('attachExpectedSteps') >= 0);
  assert.ok(worker.indexOf("d.mode === 'steps'") >= 0);
});

Promise.all(pending).then(function () {
  console.log(passed + ' passed');
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});
