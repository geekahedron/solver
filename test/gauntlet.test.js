'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const Core = require(path.join(root, 'src/core.js'));
require(path.join(root, 'src/tree.js'));
const Pack = require(path.join(root, 'src/pack.js'));
const Engine = require(path.join(root, 'src/engine.js'));
const Gauntlet = require(path.join(root, 'src/gauntlet.js'));

const source = fs.readFileSync(path.join(root, 'src/packs/rules/dungleon.js'), 'utf8');
const rules = Pack.evalRules(source);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/packs/dungleon.json'), 'utf8'));
const knownText = fs.readFileSync(path.join(root, 'src/packs/dungleon-prevsolutions.txt'), 'utf8');
const pack = Pack.normalize(manifest, manifest.variants[0]);
pack.rulesImpl = rules;
const eng = Engine.create(pack, { answers: knownText, guesses: '' });

function idx(word) {
  assert.ok(eng.keyIdx.has(word), 'missing ' + word);
  return eng.keyIdx.get(word);
}
function names(list) {
  return list.map(function (i) { return eng.keys[i]; }).sort();
}
function specFor(floors, layer) {
  return {
    floors: floors,
    tokensOf: function (i) { return eng.tokens[i]; },
    tokensOfKey: function (key) { return Pack.parseWord(key, pack); },
    keyOf: function (i) { return eng.keys[i]; },
    layer: layer || 'known',
    order: Pack.alphabetTokens(pack),
    length: 5
  };
}

assert.deepStrictEqual(pack.gauntlet, { floors: 3 });
assert.strictEqual(manifest.gauntlet.floors, 3);
const wordle = Pack.normalize(
  JSON.parse(fs.readFileSync(path.join(root, 'src/packs/wordle-en.json'), 'utf8')),
  JSON.parse(fs.readFileSync(path.join(root, 'src/packs/wordle-en.json'), 'utf8')).variants[1]
);
assert.ok(!wordle.gauntlet);

const checked = Pack.validateManifest(manifest);
assert.strictEqual(checked.ok, true, JSON.stringify(checked.errors));
const badFloors = Pack.validateManifest({
  id: 'g',
  name: 'G',
  rules: 'builtin:wordle',
  gauntlet: { floors: 1 },
  variants: [{ id: 'g', length: 5, knownSolutions: ['crane'] }]
});
assert.strictEqual(badFloors.ok, false);
assert.ok(badFloors.errors.some(function (e) { return e.path === 'gauntlet.floors'; }));
const asBool = Pack.normalize({ id: 'g', name: 'G', gauntlet: true, alphabet: 'ab' }, { id: 'g', length: 2 });
assert.deepStrictEqual(asBool.gauntlet, { floors: 3 });
const variantOnly = Pack.validateManifest({
  id: 'g',
  name: 'G',
  rules: 'builtin:wordle',
  variants: [{ id: 'g', length: 5, knownSolutions: ['crane'], gauntlet: true }]
});
assert.strictEqual(variantOnly.ok, true, JSON.stringify(variantOnly.errors));
assert.ok(variantOnly.warnings.some(function (e) { return e.path === 'variants[0].gauntlet'; }));
assert.ok(!Pack.normalize({
  id: 'g', name: 'G', alphabet: 'ab',
  variants: [{ gauntlet: { floors: 3 } }]
}, { id: 'g', length: 2 }).gauntlet);

assert.strictEqual(Gauntlet.solvedClue([
  { key: 'WBBOo', digits: [0, 2, 2, 2, 2] },
  { key: 'AWBBC', digits: [2, 2, 2, 2, 2] }
], eng.correctValues), 'AWBBC');
assert.strictEqual(Gauntlet.solvedClue([
  { key: 'WBBOo', digits: [4, 2, 2, 4, 2] }
], [2, 4]), 'WBBOo');
assert.strictEqual(Gauntlet.solvedClue([{ key: 'WBBOo', digits: [2, 2, 1, 2, 2] }], [2, 4]), null);

// Floor 1 solution WBBOo {W,B,O,o}. Floor 2 keeps anything that shares one
// of those entities and drops a dungeon that shares none.
const floor2in = [idx('AWBBC'), idx('KACoO'), idx('KZNCR')];
const open = specFor([
  { known: [idx('WBBOo'), idx('AWBBC'), idx('KZNCR')], theoretical: [idx('WBBOo'), idx('WBBBB')], solution: 'WBBOo' },
  { known: floor2in.slice(), theoretical: [idx('WBBBB'), idx('ACBBC'), idx('KZNCR')] },
  { known: [idx('AWBBC'), idx('KACoO'), idx('KZNCR')], theoretical: [idx('AWBBC'), idx('KACoO'), idx('KZNCR')] }
], 'known');
let view = Gauntlet.propagate(open);
assert.strictEqual(view.floors[0].constraint.status, 'none');
assert.strictEqual(view.floors[0].solution, 'WBBOo');
assert.strictEqual(view.floors[0].solutionSource, 'entered');
assert.deepStrictEqual(names(view.floors[0].known), ['AWBBC', 'KZNCR', 'WBBOo']);
assert.strictEqual(view.floors[1].constraint.status, 'ready');
assert.strictEqual(view.floors[1].constraint.partial, false);
assert.deepStrictEqual(view.floors[1].constraint.must, ['W', 'B', 'O', 'o']);
assert.deepStrictEqual(names(view.floors[1].known), ['AWBBC', 'KACoO']);
assert.ok(names(view.floors[1].theoretical).indexOf('WBBBB') >= 0, 'warrior/bats share W,B');
assert.ok(names(view.floors[1].theoretical).indexOf('ACBBC') >= 0, 'chest shares nothing with W,B,O,o? A,C,B — B matches');
assert.ok(names(view.floors[1].theoretical).indexOf('KZNCR') < 0);

// Floor 2 is not solved. Both remaining candidates contain W, and neither
// contains O or o, so floor 3's bound is {W,B} rather than all of floor 1.
// KACoO shares O/o with floor 1 but cannot be the common entity.
const partialFloors = [
  { known: [idx('WBBOo')], theoretical: [idx('WBBOo')], solution: 'WBBOo' },
  { known: [idx('AWBBC'), idx('AWSCw')], theoretical: [idx('AWBBC'), idx('AWSCw')] },
  { known: [idx('AWBBC'), idx('KACoO'), idx('KZNCR'), idx('AWSCw')], theoretical: [idx('AWBBC'), idx('KACoO'), idx('KZNCR'), idx('AWSCw')] }
];
view = Gauntlet.propagate(specFor(partialFloors, 'known'));
assert.strictEqual(view.floors[1].solution, null);
assert.strictEqual(view.floors[2].constraint.status, 'partial');
assert.strictEqual(view.floors[2].constraint.partial, true);
assert.deepStrictEqual(view.floors[2].constraint.must, ['W', 'B']);
assert.deepStrictEqual(view.floors[2].constraint.knownMust, ['W', 'B']);
assert.deepStrictEqual(names(view.floors[2].known), ['AWBBC', 'AWSCw']);
assert.ok(names(view.floors[2].known).indexOf('KACoO') < 0);
assert.ok(names(view.floors[2].known).indexOf('KZNCR') < 0);

// Typing floor 2's solution replaces the bound with the exact intersection.
partialFloors[1].solution = 'KACoO';
view = Gauntlet.propagate(specFor(partialFloors, 'known'));
assert.strictEqual(view.floors[1].solution, 'KACoO');
assert.strictEqual(view.floors[1].solutionSource, 'entered');
assert.strictEqual(view.floors[2].constraint.status, 'ready');
assert.strictEqual(view.floors[2].constraint.partial, false);
assert.deepStrictEqual(view.floors[2].constraint.must, ['O', 'o']);
assert.deepStrictEqual(names(view.floors[2].known), ['KACoO']);

// Clearing it widens floor 3 back to the bound. Floor 2 is open again.
partialFloors[1].solution = '';
view = Gauntlet.propagate(specFor(partialFloors, 'known'));
assert.strictEqual(view.floors[1].solution, null);
assert.strictEqual(view.floors[2].constraint.status, 'partial');
assert.deepStrictEqual(view.floors[2].constraint.must, ['W', 'B']);

// Clearing floor 1 drops the filter on every later floor, even if floor 2
// still has a typed solution. Floor 1 itself has two candidates, so it is
// not solved by narrowing either.
partialFloors[0].solution = null;
partialFloors[0].known = [idx('WBBOo'), idx('AWBBC')];
partialFloors[0].theoretical = [idx('WBBOo'), idx('AWBBC')];
partialFloors[1].solution = 'KACoO';
view = Gauntlet.propagate(specFor(partialFloors, 'known'));
assert.strictEqual(view.floors[0].solutionSource, null);
assert.strictEqual(view.floors[1].constraint.status, 'waiting');
assert.strictEqual(view.floors[2].constraint.status, 'waiting');
assert.deepStrictEqual(names(view.floors[1].known), ['AWBBC', 'AWSCw']);
assert.deepStrictEqual(names(view.floors[2].known), ['AWBBC', 'AWSCw', 'KACoO', 'KZNCR']);

// No entity in common: floor 3 is empty on both layers.
view = Gauntlet.propagate(specFor([
  { known: [idx('WBBOo')], theoretical: [idx('WBBOo')], solution: 'WBBOo' },
  { known: [idx('KZNCR')], theoretical: [idx('KZNCR')], solution: 'KZNCR' },
  { known: [idx('AWBBC'), idx('KZNCR'), idx('WBBOo')], theoretical: [idx('WBBBB'), idx('ACBBC')] }
], 'known'));
assert.strictEqual(view.floors[2].constraint.status, 'impossible');
assert.deepStrictEqual(view.floors[2].constraint.must, []);
assert.deepStrictEqual(view.floors[2].known, []);
assert.deepStrictEqual(view.floors[2].theoretical, []);

// The two layers can disagree while floor 2 is open. Known still has two
// warrior dungeons, so the floor is not solved. Theoretical is down to a
// goblin/orc dungeon, and that layer's bound is only O/o.
view = Gauntlet.propagate(specFor([
  { known: [idx('WBBOo')], theoretical: [idx('WBBOo')], solution: 'WBBOo' },
  { known: [idx('AWBBC'), idx('AWSCw')], theoretical: [idx('KACoO')] },
  { known: [idx('AWBBC'), idx('KACoO'), idx('AWSCw')], theoretical: [idx('AWBBC'), idx('KACoO'), idx('AWSCw')] }
], 'known'));
assert.strictEqual(view.floors[2].constraint.layersDiffer, true);
assert.deepStrictEqual(view.floors[2].constraint.knownMust, ['W', 'B']);
assert.deepStrictEqual(view.floors[2].constraint.theoreticalMust, ['O', 'o']);
assert.deepStrictEqual(names(view.floors[2].known), ['AWBBC', 'AWSCw']);
assert.deepStrictEqual(names(view.floors[2].theoretical), ['KACoO']);
assert.strictEqual(view.floors[2].constraint.status, 'partial');

// Active layer picks which unique answer counts. Known has one row;
// theoretical still has two, so a theoretical solve is not finished.
const layerFloors = [
  { known: [idx('WBBOo')], theoretical: [idx('WBBOo'), idx('WBBBB')] },
  { known: floor2in.slice(), theoretical: floor2in.slice() }
];
view = Gauntlet.propagate(specFor(layerFloors, 'theoretical'));
assert.strictEqual(view.floors[0].solution, null);
assert.strictEqual(view.floors[1].constraint.status, 'waiting');
assert.strictEqual(view.floors[1].known.length, 3);
view = Gauntlet.propagate(specFor(layerFloors, 'known'));
assert.strictEqual(view.floors[0].solution, 'WBBOo');
assert.strictEqual(view.floors[0].solutionSource, 'unique');
assert.ok(names(view.floors[1].known).indexOf('KZNCR') < 0);
view = Gauntlet.propagate(specFor(layerFloors, 'preferred'));
assert.strictEqual(view.floors[0].solution, 'WBBOo');

// An all-correct guess is the solution even when that word is already
// gone from the lists. An entered solution beats it.
view = Gauntlet.propagate(specFor([
  { known: [], theoretical: [], clueSolution: 'WBBOo' },
  { known: floor2in.slice(), theoretical: floor2in.slice() }
], 'known'));
assert.strictEqual(view.floors[0].solution, 'WBBOo');
assert.strictEqual(view.floors[0].solutionSource, 'clue');
assert.deepStrictEqual(names(view.floors[1].known), ['AWBBC', 'KACoO']);
view = Gauntlet.propagate(specFor([
  { known: [], theoretical: [], solution: 'KZNCR', clueSolution: 'WBBOo' },
  { known: floor2in.slice(), theoretical: floor2in.slice() }
], 'known'));
assert.strictEqual(view.floors[0].solution, 'KZNCR');
assert.strictEqual(view.floors[0].solutionSource, 'entered');
assert.deepStrictEqual(view.floors[1].constraint.must, ['K', 'N', 'Z', 'C', 'R']);

// A short string is not a solution yet.
view = Gauntlet.propagate(specFor([
  { known: [idx('WBBOo'), idx('AWBBC')], theoretical: [], solution: 'WB' },
  { known: floor2in.slice(), theoretical: [] }
], 'known'));
assert.strictEqual(view.floors[0].solution, null);
assert.strictEqual(view.floors[1].constraint.status, 'waiting');

// Openers are re-ranked against the narrowed pool. The full known list
// still opens with AWSCw. Two unrelated answers do not.
const full = Gauntlet.rankOpeners(Core, {
  U: eng.U, L: 5, K: eng.syms.length, rule: eng.feedbackRule, hooks: eng.scoringHooks,
  rem: eng.knownIdx, guessIdx: eng.guessIdx, keys: eng.keys,
  lookup: function (w) { return eng.keyIdx.has(w) ? eng.keyIdx.get(w) : -1; },
  declared: false
});
assert.strictEqual(full.source, 'generated');
assert.strictEqual(full.words.length, 10);
assert.strictEqual(full.words[0], 'AWSCw');
assert.ok(full.bits.AWSCw > 5);
const narrow = Gauntlet.rankOpeners(Core, {
  U: eng.U, L: 5, K: eng.syms.length, rule: eng.feedbackRule, hooks: eng.scoringHooks,
  rem: [idx('WBBOo'), idx('KZNCR')], guessIdx: eng.guessIdx, keys: eng.keys,
  lookup: function (w) { return eng.keyIdx.has(w) ? eng.keyIdx.get(w) : -1; },
  declared: false
});
assert.strictEqual(narrow.words.length, 10);
assert.notStrictEqual(narrow.words[0], 'AWSCw');
assert.ok(Math.abs(narrow.bits[narrow.words[0]] - 1) < 1e-9, narrow.bits[narrow.words[0]]);
assert.ok(narrow.words[0] === 'WBBOo' || narrow.words[0] === 'KZNCR', narrow.words[0]);
let prev = Infinity;
narrow.words.forEach(function (word) {
  assert.ok(narrow.bits[word] <= prev + 1e-9, word);
  prev = narrow.bits[word];
});

const authored = Gauntlet.rankOpeners(Core, {
  U: eng.U, L: 5, K: eng.syms.length, rule: eng.feedbackRule, hooks: eng.scoringHooks,
  rem: [idx('WBBOo'), idx('KZNCR')], guessIdx: eng.guessIdx, keys: eng.keys,
  lookup: function (w) { return eng.keyIdx.has(w) ? eng.keyIdx.get(w) : -1; },
  declared: true,
  authored: ['KZNCR', 'WBBOo']
});
assert.strictEqual(authored.source, 'pack');
assert.deepStrictEqual(authored.words, ['KZNCR', 'WBBOo']);
assert.ok(authored.bits.KZNCR > 0);

const empty = Gauntlet.rankOpeners(Core, { rem: [], declared: false, keys: eng.keys });
assert.deepStrictEqual(empty.words, []);

function alphaOf(engine) {
  return Pack.alphabetTokens(engine.pack).map(function (token) {
    const id = engine.symId.has(token) ? engine.symId.get(token) : engine.symIdOf(token);
    return { token: token, id: id };
  });
}
const dictOpen = Gauntlet.rankOpeners(Core, {
  U: eng.U, L: 5, K: eng.syms.length, rule: eng.feedbackRule, hooks: eng.scoringHooks,
  rem: eng.knownIdx, guessIdx: eng.guessIdx, keys: eng.keys,
  lookup: function (w) { return eng.keyIdx.has(w) ? eng.keyIdx.get(w) : -1; },
  declared: false, guessMode: 'dictionary', alphabet: alphaOf(eng)
});
assert.strictEqual(dictOpen.words[0], 'AWSCw');
assert.strictEqual(dictOpen.anyMixed, false);
dictOpen.words.forEach(function (w) { assert.ok(eng.keyIdx.has(w), w); });
assert.deepStrictEqual(dictOpen.words, full.words);

const anyOpen = Gauntlet.rankOpeners(Core, {
  U: eng.U, L: 5, K: eng.syms.length, rule: eng.feedbackRule, hooks: eng.scoringHooks,
  rem: eng.knownIdx, guessIdx: eng.guessIdx, keys: eng.keys,
  lookup: function (w) { return eng.keyIdx.has(w) ? eng.keyIdx.get(w) : -1; },
  declared: false, guessMode: 'any', alphabet: alphaOf(eng),
  skip: function (w) { return eng.keyIdx.has(w); },
  format: function (tokens) { return tokens.join(''); }
});
assert.strictEqual(anyOpen.source, 'generated');
assert.strictEqual(anyOpen.anyMixed, true);
assert.strictEqual(anyOpen.words.length, 10);
let anyPrev = Infinity;
let nonDungeon = 0;
anyOpen.words.forEach(function (w) {
  assert.ok(anyOpen.bits[w] <= anyPrev + 1e-9, w + ' ' + anyOpen.bits[w]);
  anyPrev = anyOpen.bits[w];
  assert.strictEqual(eng.encode(w).key, w, w);
  if (!eng.keyIdx.has(w)) {
    nonDungeon++;
    assert.strictEqual(rules.validSolution(w, eng), false, w);
  }
});
assert.ok(nonDungeon >= 1, anyOpen.words.join(','));
assert.ok(anyOpen.bits[anyOpen.words[0]] + 1e-9 >= dictOpen.bits.AWSCw, anyOpen.bits[anyOpen.words[0]]);
console.log('any-mode openers:');
anyOpen.words.forEach(function (w) {
  console.log('  ' + w + '  ' + anyOpen.bits[w].toFixed(3) + ' bits  ' + (eng.keyIdx.has(w) ? 'listed dungeon' : 'not a listed dungeon'));
});

// Floor 1 solved as VWSCR (ggggg). Floor 2 guess AWSCw, clue rgGgr:
// slot 1 is not A, slot 2 is W, slot 3 is S and the secret has another S,
// slot 4 is C, slot 5 is not w. The dungeons are ?WSCS. They already share
// W/S/C with floor 1, so the shared-entity filter must not drop them.
function played(word, text) {
  const parsed = Pack.parseClue(text, pack);
  assert.ok(parsed, text);
  const made = eng.makeClue(word, parsed.digits);
  assert.ok(!made.err, made.err || word);
  return made;
}
function floorOf(clues) {
  const parts = eng.replay(clues, 'known');
  return {
    known: parts.known.slice(),
    theoretical: parts.theoretical.slice(),
    clueSolution: Gauntlet.solvedClue(clues, eng.correctValues)
  };
}
const wscs = ['KWSCS', 'VWSCS', 'tWSCS'];
const floor1 = floorOf([played('VWSCR', 'ggggg')]);
const floor2clue = played('AWSCw', 'rgGgr');
const floor2 = floorOf([floor2clue]);
const floor3 = floorOf([played('AWSCw', 'rgGgr')]);
assert.strictEqual(floor1.clueSolution, 'VWSCR');
assert.strictEqual(floor2clue.afterKnown, 1);
assert.strictEqual(floor2clue.afterTheo, 3);
assert.deepStrictEqual(names(floor2.known), ['VWSCS']);
assert.deepStrictEqual(names(floor2.theoretical), wscs);
wscs.forEach(function (word) {
  assert.strictEqual(word.slice(1), 'WSCS', word);
});

view = Gauntlet.propagate(specFor([floor1, floor2, floor3], 'known'));
assert.strictEqual(view.floors[0].solution, 'VWSCR');
assert.strictEqual(view.floors[0].solutionSource, 'clue');
assert.deepStrictEqual(view.floors[1].constraint.must, ['W', 'V', 'S', 'C', 'R']);
assert.deepStrictEqual(names(view.floors[1].known), names(floor2.known));
assert.deepStrictEqual(names(view.floors[1].theoretical), names(floor2.theoretical));
// The only known answer solves floor 2 on the known layer. Floor 3's shared
// set is VWSCR ∩ VWSCS. The same clue there still leaves every ?WSCS dungeon.
assert.strictEqual(view.floors[1].solution, 'VWSCS');
assert.strictEqual(view.floors[1].solutionSource, 'unique');
assert.deepStrictEqual(view.floors[2].constraint.must, ['W', 'V', 'S', 'C']);
assert.strictEqual(view.floors[2].constraint.partial, false);
assert.deepStrictEqual(names(view.floors[2].known), ['VWSCS']);
assert.deepStrictEqual(names(view.floors[2].theoretical), wscs);

// On the theoretical layer floor 2 is still open (three dungeons). Floor 3's
// bound is the entities of VWSCR that still appear in one of those dungeons.
// R does not. K and t are not on floor 1. W, V, S, and C are. None of the
// ?WSCS dungeons are removed.
view = Gauntlet.propagate(specFor([floor1, floor2, floor3], 'theoretical'));
assert.strictEqual(view.floors[1].solution, null);
assert.strictEqual(view.floors[2].constraint.status, 'partial');
assert.strictEqual(view.floors[2].constraint.partial, true);
assert.deepStrictEqual(view.floors[2].constraint.theoreticalMust, ['W', 'V', 'S', 'C']);
assert.deepStrictEqual(view.floors[2].constraint.knownMust, ['W', 'V', 'S', 'C']);
assert.deepStrictEqual(names(view.floors[2].known), ['VWSCS']);
assert.deepStrictEqual(names(view.floors[2].theoretical), wscs);

console.log('ok gauntlet', view.floors.length, 'floors');
