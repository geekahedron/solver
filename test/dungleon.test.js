'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const Core = require(path.join(root, 'src/core.js'));
require(path.join(root, 'src/tree.js'));
const Pack = require(path.join(root, 'src/pack.js'));
const Engine = require(path.join(root, 'src/engine.js'));

const MARK = ['r', 'y', 'g', 'Y', 'G'];

function clueString(digits) {
  return digits.map(function (d) { return MARK[d]; }).join('');
}

const source = fs.readFileSync(path.join(root, 'src/packs/rules/dungleon.js'), 'utf8');
const rules = Pack.evalRules(source);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/packs/dungleon.json'), 'utf8'));
const knownText = fs.readFileSync(path.join(root, 'src/packs/dungleon-prevsolutions.txt'), 'utf8');
const pack = Pack.normalize(manifest, manifest.variants[0]);
pack.rulesImpl = rules;

const eng = Engine.create(pack, { answers: knownText, guesses: 'CMFCS\nAWSSB\nVZCFS\n' });

function ids(word) {
  const enc = eng.encode(word);
  assert.ok(!enc.err, word + ' ' + (enc.err || ''));
  return enc.ids;
}

function marksOf(solution, guess) {
  const fb = rules.feedback(guess, solution);
  return clueString(fb.digits);
}

// get_clue examples from dungleon-solver.pl, including plus marks.
assert.strictEqual(marksOf('WCSCS', 'CMFCS'), 'yrrgG');
assert.strictEqual(marksOf('WCCCS', 'CMFCS'), 'YrrGg');
assert.strictEqual(marksOf('WBBSC', 'AWSSB'), 'ryrgY');
assert.strictEqual(marksOf('WBBCC', 'WBBCC'), 'ggggg');

// The extra copy sits to the right of the green tile. A running count of
// copies already seen marks that green plain (rgggr / ggggr) and then no
// dungeon matches the real clue.
assert.strictEqual(marksOf('VWSCS', 'AWSCw'), 'rgGgr');
assert.strictEqual(marksOf('KWSCS', 'AWSCw'), 'rgGgr');
assert.strictEqual(marksOf('tWSCS', 'AWSCw'), 'rgGgr');
assert.strictEqual(marksOf('SSCCS', 'SSCCw'), 'GGggr');
// CWSCS is ?WSCS, but the second chest makes slot 4 plus, so it is not rgGgr.
assert.strictEqual(marksOf('CWSCS', 'AWSCw'), 'rgGGr');

// Capital Y/G is not the Wordle collapse of the same guess.
assert.deepStrictEqual(eng.feedbackDigits('CMFCS', 'WCCCS'), [3, 0, 0, 4, 2]);
assert.deepStrictEqual(eng.feedbackDigits('CMFCS', 'WCSCS'), [1, 0, 0, 2, 4]);
assert.notDeepStrictEqual(eng.feedbackDigits('CMFCS', 'WCCCS'), [1, 0, 0, 2, 2]);

['WCSCS', 'WCCCS', 'WBBSC', 'WBBCC', 'VWSCS', 'KWSCS', 'tWSCS', 'SSCCS', 'CWSCS'].forEach(function (solution) {
  ['CMFCS', 'AWSSB', 'WBBCC', 'AWSCw', 'SSCCw', solution].forEach(function (guess) {
    const fb = rules.feedback(guess, solution);
    const pat = rules.feedbackIds(ids(guess), 0, ids(solution), 0, 5);
    assert.strictEqual(pat, fb.pat, guess + ' vs ' + solution);
    assert.strictEqual(clueString(Pack.patToDigits(pat, 5, 5)), clueString(fb.digits));
  });
});

// Scratch in feedbackIds must not leak across calls.
const known = knownText.split(/\s+/).filter(Boolean);
assert.strictEqual(known.length, 397);
assert.strictEqual(new Set(known).size, 397);
['WSoCSO', 'KACDCR', 'cAcccw', 'tWOCCo', 'ZVCFCN', 'ZToNOw', 'kAkSk', 'Akkkw'].forEach(function (word) {
  assert.ok(known.indexOf(word) < 0, word);
});
for (let i = 0; i < known.length; i += 17) {
  const secret = known[i];
  const pat = rules.feedbackIds(ids('CMFCS'), 0, ids(secret), 0, 5);
  assert.strictEqual(pat, rules.feedback('CMFCS', secret).pat, secret);
}

assert.strictEqual(rules.validSolution('WBBCC'), true, 'warrior, paired bats, chests');
assert.strictEqual(rules.validSolution('WsCss'), true, 'three spiders');
assert.strictEqual(rules.validSolution('MFBCC'), true, 'frogged bat');
assert.strictEqual(rules.validSolution('KZNBB'), true, 'zombified hero');
assert.strictEqual(rules.validSolution('WBBBB'), true, 'four bats behind a warrior');
assert.strictEqual(rules.validSolution('CBBCC'), false, 'no hero');
assert.strictEqual(rules.validSolution('WsCCC'), false, 'a single spider');
assert.strictEqual(rules.validSolution('WTSSC'), false, 'troll with treasure');
assert.strictEqual(rules.validSolution('ABBCC'), false, 'archer facing a monster');
assert.strictEqual(rules.validSolution('WSSCc'), false, 'a single coin');

assert.strictEqual(rules.validGuess(Pack.parseWord('WBBCC', pack), eng), true);
assert.strictEqual(rules.validGuess(Pack.parseWord('sssss', pack), eng), true);
assert.strictEqual(rules.validGuess(Pack.parseWord('WBB', pack), eng), false);
assert.strictEqual(rules.validGuess(Pack.parseWord('bbbbb', pack), eng), false);

assert.strictEqual(eng.nKnown, 397);
assert.strictEqual(eng.theoreticalIdx.length, 3312);
assert.strictEqual(eng.ruleDrift.length, 0);
assert.strictEqual(eng.pack.caseInsensitive, false);
assert.strictEqual(eng.clueBase, 5);
assert.ok(eng.scoringHooks);
known.forEach(function (word) {
  assert.ok(eng.keyIdx.has(word), word);
  assert.ok(eng.flags[eng.keyIdx.get(word)].known, word);
  assert.ok(rules.validSolution(word), word);
});
assert.ok(eng.flags[eng.keyIdx.get('WBBBB')].theoretical);
assert.ok(!eng.flags[eng.keyIdx.get('WBBBB')].known);
assert.strictEqual(eng.encode('WBBcC').key, 'WBBcC');
assert.notStrictEqual(eng.encode('WBBcC').key, 'WBBCC');

const parsed = Pack.parseClue('YrrGg', pack);
assert.deepStrictEqual(parsed.digits, [3, 0, 0, 4, 2]);
assert.deepStrictEqual(Pack.parseClue('yrrgG', pack).digits, [1, 0, 0, 2, 4]);
assert.deepStrictEqual(Pack.parseClue('rrYrr', pack).digits, [0, 0, 3, 0, 0]);
assert.notStrictEqual(Pack.parseClue('YrrGg', pack).pat, Pack.parseClue('yrrgg', pack).pat);

// ACBBC has two chests and ACBBR has one. VZCFS marks the chest Y versus y.
// Wordle's 3-mark feedback gives both the same pattern, so a base-3 scorer
// would leave both answers in one bucket.
const plus = eng.makeClue('VZCFS', [0, 0, 3, 0, 0]);
assert.strictEqual(eng.feedbackPat(plus.ids, eng.keyIdx.get('ACBBC')), plus.pat);
assert.strictEqual(eng.consistentAllIndex(eng.keyIdx.get('ACBBC'), [plus]), true);
assert.strictEqual(eng.consistentAllIndex(eng.keyIdx.get('ACBBR'), [plus]), false);
assert.strictEqual(rules.consistent(
  Pack.parseWord('VZCFS', pack),
  plus.clue,
  Pack.parseWord('ACBBC', pack),
  eng
), true);

const rem = Int32Array.from([eng.keyIdx.get('ACBBC'), eng.keyIdx.get('ACBBR')]);
const pool = Int32Array.from([eng.keyIdx.get('VZCFS')]);
const isCand = new Uint8Array(eng.nWords);
const scored = Core.scorePool(eng.U, 5, eng.syms.length, 'wordle', rem, pool, isCand, null, eng.scoringHooks);
const collapsed = Core.scorePool(eng.U, 5, eng.syms.length, 'wordle', rem, pool, isCand);
assert.strictEqual(scored[0].splits, 2);
assert.strictEqual(collapsed[0].splits, 1);

// Five-mark feedback changes the entropy. Wordle's 3-mark collapse puts
// ACBBC and ACBBR in one bucket (0 bits). The pack marks split them (1 bit).
const plusInfo = Core.rankByInformation({
  U: eng.U, L: 5, K: eng.syms.length, rule: eng.feedbackRule,
  rem: rem, pool: pool, hooks: eng.scoringHooks
});
const plusCollapsed = Core.rankByInformation({
  U: eng.U, L: 5, K: eng.syms.length, rule: 'wordle',
  rem: rem, pool: pool, hooks: null
});
assert.strictEqual(plusInfo.length, 1);
assert.ok(Math.abs(plusInfo[0].ent - 1) < 1e-9, plusInfo[0].ent);
assert.ok(Math.abs(plusCollapsed[0].ent) < 1e-9, plusCollapsed[0].ent);

// No authored list: rank the 397 known solutions (the whole guess list at
// the start of a game) by expected information. Case stays as stored.
assert.ok(!manifest.openers || !manifest.openers.length);
assert.deepStrictEqual(pack.openers, []);
const knownIdx = Int32Array.from(eng.knownIdx);
const opening = Core.rankByInformation({
  U: eng.U, L: 5, K: eng.syms.length, rule: eng.feedbackRule,
  rem: knownIdx, pool: knownIdx, hooks: eng.scoringHooks
});
assert.strictEqual(opening.length, 397);
assert.strictEqual(eng.keys[opening[0].idx], 'AWSCw');
assert.ok(opening[0].ent > opening[1].ent);
assert.ok(opening[0].ent > 5.4 && opening[0].ent < 5.6, opening[0].ent);
assert.ok(!eng.keyIdx.has('AWSCW'));
assert.notStrictEqual(eng.encode('AWSCw').key, eng.encode('AWSCW').key);
const generated = Core.chooseOpenerList({
  declared: false,
  scores: opening.map(function (s, i) {
    return { word: eng.keys[s.idx], bits: s.ent, cand: s.cand, exp: s.exp, i: i };
  })
});
assert.strictEqual(generated.source, 'generated');
assert.strictEqual(generated.words.length, 10);
assert.strictEqual(generated.words[0], 'AWSCw');
const wordleOpeners = ['slate', 'tarps', 'crane', 'cramp', 'trace', 'stare', 'crate', 'raise', 'alert', 'later'];
generated.words.forEach(function (word) {
  assert.strictEqual(eng.encode(word).key, word, word);
  assert.ok(eng.flags[eng.keyIdx.get(word)].known, word);
  assert.ok(wordleOpeners.indexOf(word) < 0, word);
});
let prevBits = Infinity;
generated.words.forEach(function (word) {
  const row = opening.filter(function (s) { return eng.keys[s.idx] === word; })[0];
  assert.ok(row.ent <= prevBits + 1e-9, word);
  prevBits = row.ent;
});

const parts = eng.partition([plus]);
// ACBBC matches rrYrr but is not in the previous-solutions list. ACBBR does not match.
assert.ok(!eng.flags[eng.keyIdx.get('ACBBC')].known);
assert.ok(parts.known.indexOf(eng.keyIdx.get('ACBBC')) < 0);
assert.ok(parts.known.indexOf(eng.keyIdx.get('ACBBR')) < 0);
assert.ok(parts.theoretical.indexOf(eng.keyIdx.get('ACBBC')) >= 0);
assert.ok(parts.theoretical.indexOf(eng.keyIdx.get('ACBBR')) < 0);
assert.deepStrictEqual(parts.known.map(function (i) { return eng.keys[i]; }).sort(), [
  'ACBCB', 'ACDCR', 'CWBBC', 'CWDCR', 'CWoCO'
]);
assert.strictEqual(parts.known.length, 5);
assert.strictEqual(parts.theoretical.length, 17);

// Normal (non-gauntlet) mode: AWSCw + rgGgr is exactly the ?WSCS dungeons
// the generator allows. Slot 1 is K, V, or t. VWSCS is in the known list.
const rightPlus = eng.makeClue('AWSCw', Pack.parseClue('rgGgr', pack).digits);
const rightParts = eng.partition([rightPlus]);
assert.deepStrictEqual(rightParts.known.map(function (i) { return eng.keys[i]; }).sort(), ['VWSCS']);
assert.deepStrictEqual(rightParts.theoretical.map(function (i) { return eng.keys[i]; }).sort(), [
  'KWSCS', 'VWSCS', 'tWSCS'
]);
rightParts.theoretical.forEach(function (i) {
  const word = eng.keys[i];
  assert.strictEqual(word.slice(1), 'WSCS', word);
  assert.notStrictEqual(word.charAt(0), 'A', word);
});

console.log('ok dungleon', eng.nKnown, 'known', eng.theoreticalIdx.length, 'theoretical');
