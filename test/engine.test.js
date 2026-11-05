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

Promise.all(pending).then(function () {
  console.log(passed + ' passed');
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});
