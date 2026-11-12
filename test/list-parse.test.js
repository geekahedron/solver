'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ListParse = require(path.join(root, 'src/list-parse.js'));
const Pack = require(path.join(root, 'src/pack.js'));
const Engine = require(path.join(root, 'src/engine.js'));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('ok', name);
}

function fixture(name, words) {
  return 'const ' + name + ' = [' + words.map(function (w) { return '"' + w + '"'; }).join(',') + '];\n';
}

check('extracts quoted 5-letter words and folds case', function () {
  const src = fixture('official_answers_with_ed', ['ABACK', 'ABASE', 'crane', 'SLATE']);
  const parsed = ListParse.parseConstArray(src, { length: 5, minCount: 4 });
  assert.strictEqual(parsed.ok, true);
  assert.deepStrictEqual(parsed.words, ['aback', 'abase', 'crane', 'slate']);
  assert.strictEqual(parsed.count, 4);
});

check('accepts single quotes and drops duplicate spellings', function () {
  const src = "const official_words = ['CRANE','crane','SLATE'];\n";
  const parsed = ListParse.parseConstArray(src, { minCount: 1 });
  assert.strictEqual(parsed.ok, true);
  assert.deepStrictEqual(parsed.words, ['crane', 'slate']);
});

check('does not evaluate the source', function () {
  global.PWNED = false;
  const src = fixture('official_answers', ['ABBEY', 'ABORT']) +
    'throw new Error("executed");\nglobal.PWNED = true;\n';
  const parsed = ListParse.parseConstArray(src, { minCount: 2 });
  assert.strictEqual(parsed.ok, true);
  assert.deepStrictEqual(parsed.words, ['abbey', 'abort']);
  assert.strictEqual(global.PWNED, false);
  delete global.PWNED;
});

check('rejects HTML, short lists, and non-words', function () {
  const html = ListParse.parseConstArray('<!DOCTYPE html><html><body>const x = ["CRANE"];</body></html>', { minCount: 1 });
  assert.strictEqual(html.ok, false);
  assert.ok(/HTML/.test(html.error));

  const short = ListParse.parseConstArray(fixture('official_answers', ['CRANE']), { minCount: 2000 });
  assert.strictEqual(short.ok, false);
  assert.strictEqual(short.count, 1);
  assert.ok(/at least 2000/.test(short.error));

  const bad = ListParse.parseConstArray('const official_words = ["CRANE","NO","SLATE"];', { minCount: 1 });
  assert.strictEqual(bad.ok, false);
  assert.ok(/not 5 letters/.test(bad.error));

  const huge = ListParse.parseConstArray(fixture('official_words', ['CRANE', 'SLATE', 'TARPS']), { minCount: 1, maxCount: 2 });
  assert.strictEqual(huge.ok, false);
  assert.ok(/maximum/.test(huge.error));
});

check('rejects a file that is not a const array', function () {
  const parsed = ListParse.parseConstArray('["CRANE","SLATE","TARPS","CRANE","TRACE"]', { minCount: 1 });
  assert.strictEqual(parsed.ok, false);
  assert.ok(/const array/.test(parsed.error));
});

check('live pack manifest points at the WordGamesBot raw lists', function () {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/packs/wordle-nyt.json'), 'utf8'));
  const english = JSON.parse(fs.readFileSync(path.join(root, 'src/packs/wordle-en.json'), 'utf8'));
  assert.deepStrictEqual(manifest.openers, english.openers);
  assert.strictEqual(manifest.remote.timeoutMs, 12000);
  assert.strictEqual(manifest.remote.repo, 'https://github.com/WordGamesBot/wordgamesbot.github.io');
  const answers = manifest.remote.answers;
  const guesses = manifest.remote.guesses;
  assert.deepStrictEqual(answers.map(function (x) { return x.id; }), ['with-ed', 'no-ed']);
  assert.deepStrictEqual(guesses.map(function (x) { return x.id; }), ['all', 'bot']);
  assert.strictEqual(answers[0].default, true);
  assert.strictEqual(guesses[0].default, true);
  assert.strictEqual(answers[0].url, 'https://raw.githubusercontent.com/WordGamesBot/wordgamesbot.github.io/HEAD/WordLists/NYT/Answers_with_ED.js');
  assert.strictEqual(answers[1].url, 'https://raw.githubusercontent.com/WordGamesBot/wordgamesbot.github.io/HEAD/WordLists/NYT/Answers.js');
  assert.strictEqual(guesses[0].url, 'https://raw.githubusercontent.com/WordGamesBot/wordgamesbot.github.io/HEAD/WordLists/NYT/Words.js');
  assert.strictEqual(guesses[1].url, 'https://raw.githubusercontent.com/WordGamesBot/wordgamesbot.github.io/HEAD/WordLists/NYT/Guesses.js');
  answers.concat(guesses).forEach(function (spec) {
    const sample = fixture('sample', ['CRANE', 'SLATE']);
    const tooSmall = ListParse.parseConstArray(sample, { minCount: spec.minCount, maxCount: spec.maxCount });
    assert.strictEqual(tooSmall.ok, false);
  });
});

check('parsed words load as an English-style pack and filter openers', function () {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/packs/wordle-nyt.json'), 'utf8'));
  const answers = ListParse.parseConstArray(fixture('official_answers_with_ed', ['CRANE', 'SLATE', 'CRAMP']), { minCount: 3 });
  const guesses = ListParse.parseConstArray(fixture('official_words', ['CRANE', 'SLATE', 'TARPS', 'TRACE', 'RAISE']), { minCount: 5 });
  assert.strictEqual(answers.ok && guesses.ok, true);
  const pack = Pack.normalize(manifest, manifest.variants[0]);
  const eng = Engine.create(pack, { answers: answers.words.join('\n'), guesses: guesses.words.join('\n') });
  assert.strictEqual(eng.nKnown, 3);
  // Answers are guesses too, so cramp is legal even though the guess fixture omitted it.
  assert.strictEqual(eng.guessIdx.length, 6);
  const legal = [];
  manifest.openers.forEach(function (w) { if (eng.keyIdx.has(w)) legal.push(w); });
  assert.deepStrictEqual(legal, ['slate', 'tarps', 'crane', 'cramp', 'trace', 'raise']);
  assert.strictEqual(eng.flags[eng.keyIdx.get('cramp')].known, true);
  assert.strictEqual(eng.flags[eng.keyIdx.get('tarps')].known, false);
});

check('fallback keeps a ready pack and otherwise loads English', function () {
  assert.deepStrictEqual(ListParse.choosePackFallback({
    haveReady: true, previousId: 'en5', requestedId: 'nyt'
  }), { action: 'keep', packId: 'en5' });
  assert.deepStrictEqual(ListParse.choosePackFallback({
    haveReady: true, previousId: 'nyt', requestedId: 'nyt'
  }), { action: 'keep', packId: 'nyt' });
  assert.deepStrictEqual(ListParse.choosePackFallback({
    haveReady: true, previousId: 'dungleon', requestedId: 'nyt'
  }), { action: 'keep', packId: 'dungleon' });
  assert.deepStrictEqual(ListParse.choosePackFallback({
    haveReady: false, previousId: '', requestedId: 'nyt'
  }), { action: 'load', packId: 'en5' });
  assert.deepStrictEqual(ListParse.choosePackFallback({
    haveReady: false, previousId: 'nyt', requestedId: 'nyt', fallbackId: 'en5'
  }), { action: 'load', packId: 'en5' });
});

console.log(passed + ' passed');
