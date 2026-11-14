'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const Pack = require(path.join(root, 'src/pack.js'));
const Renderers = require(path.join(root, 'src/renderers.js'));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('ok', name);
}

function readPack(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'src/packs', name), 'utf8'));
}

// Sprite order in dungleon.com client.js function V, one 32px cell each.
const SHEET = ['ar', 'ba', 'ch', 'co', 'dr', 'fr', 'go', 'ki', 'ma', 'ne', 'or', 'sk', 'sp', 'th', 'tr', 'ty', 'vi', 'wa', 'wi', 'zo', 'ca'];
const DUNGLEON = {
  W: ['Warrior', 'wa'],
  A: ['Archer', 'ar'],
  M: ['Mage', 'ma'],
  K: ['King', 'ki'],
  V: ['Villager', 'vi'],
  B: ['Bat', 'ba'],
  S: ['Skeleton', 'sk'],
  s: ['Spider', 'sp'],
  D: ['Dragon', 'dr'],
  T: ['Troll', 'tr'],
  N: ['Necromancer', 'ne'],
  O: ['Orc', 'or'],
  o: ['Goblin', 'go'],
  w: ['Wizard', 'wi'],
  t: ['Thief', 'th'],
  F: ['Frog', 'fr'],
  Z: ['Zombie', 'zo'],
  C: ['Chest', 'ch'],
  c: ['Coin', 'co'],
  R: ['Relic', 'ty'],
  k: ['Cake', 'ca']
};

check('dungleon maps every alphabet letter to its sprite cell and big image', function () {
  const manifest = readPack('dungleon.json');
  const pack = Pack.normalize(manifest, manifest.variants[0]);
  const letters = Array.from(manifest.alphabet);
  assert.strictEqual(letters.length, 21);
  assert.strictEqual(letters[letters.length - 1], 'k');
  assert.ok(pack.appearance && pack.appearance.sheet);
  assert.strictEqual(pack.appearance.sheet.columns, 21);
  assert.strictEqual(pack.appearance.sheet.rows, 1);
  assert.strictEqual(pack.appearance.sheet.gapX, 0);
  assert.strictEqual(pack.appearance.keyboard.source, 'sprite');
  assert.strictEqual(pack.appearance.tiles.source, 'image');
  assert.strictEqual(pack.appearance.sheet.cells.length, 21);
  assert.strictEqual(pack.appearance.sheet.cells[0], 'ar');
  assert.strictEqual(pack.appearance.sheet.cells[20], 'ca');
  assert.strictEqual(pack.appearance.sheet.cellWidth, 32);
  assert.deepStrictEqual(Pack.cellOrigin(pack.appearance.sheet, 17, 0), { x: 544, y: 0 });
  assert.ok(Pack.isHttpUrl(pack.appearance.sheet.url));
  letters.forEach(function (letter) {
    const spec = DUNGLEON[letter];
    assert.ok(spec, 'missing expected name for ' + letter);
    const ent = pack.appearance.entities[letter];
    assert.ok(ent, 'no entity for ' + letter);
    assert.strictEqual(ent.label, spec[0], letter);
    assert.strictEqual(ent.image, 'https://www.dungleon.com/images/elements/big/' + spec[1] + '.png');
    const cell = Pack.spriteCell(ent.sprite, pack.appearance.sheet.columns);
    assert.strictEqual(cell.index, SHEET.indexOf(spec[1]), letter + ' ' + spec[1]);
    assert.strictEqual(cell.row, 0);
    assert.strictEqual(SHEET[cell.col], spec[1]);
  });
  assert.strictEqual(pack.appearance.entities.S.label, 'Skeleton');
  assert.strictEqual(pack.appearance.entities.s.label, 'Spider');
  assert.notStrictEqual(pack.appearance.entities.S.image, pack.appearance.entities.s.image);
  assert.ok(!pack.appearance.entities.ca, 'cake is the letter k, mapped onto the existing ca frame');
  assert.strictEqual(pack.appearance.entities.k.sprite.index, SHEET.indexOf('ca'));
  assert.strictEqual(pack.appearance.sheet.cells[pack.appearance.entities.k.sprite.index], 'ca');
});

check('drops unsafe image urls and keeps the letter path empty', function () {
  const pack = Pack.normalize({
    id: 'bad-art',
    name: 'Bad art',
    alphabet: 'AB',
    appearance: {
      sheet: { url: 'javascript:alert(1)', cellWidth: 32, cellHeight: 32, columns: 2 },
      entities: {
        A: { label: 'Aye', image: 'javascript:alert(1)', sprite: { index: 0 } },
        B: { label: 'Bee', image: 'https://example.com/b.png', title: 'Bee tile' },
        C: { image: 'data:image/png;base64,aaaa' }
      }
    }
  }, { id: 'bad-art', length: 2 });
  assert.strictEqual(pack.appearance.sheet, null);
  assert.strictEqual(pack.appearance.entities.A.image, undefined);
  assert.strictEqual(pack.appearance.entities.A.label, 'Aye');
  assert.strictEqual(pack.appearance.entities.B.image, 'https://example.com/b.png');
  assert.strictEqual(pack.appearance.entities.C, undefined);
  const html = Renderers.tiles('tiles/letters', ['A', 'B'], null, {
    appearance: pack.appearance,
    showImages: true,
    art: 'image'
  });
  assert.ok(html.indexOf('javascript:') < 0, html);
  assert.ok(html.indexOf('data:') < 0, html);
  assert.ok(html.indexOf('https://example.com/b.png') > 0, html);
  assert.ok(html.indexOf('>A<') > 0, html);
});

check('sprite html uses the cell column and escapes the sheet url', function () {
  const html = Renderers.wordArt(['W'], {
    showImages: true,
    art: 'sprite',
    title: 'W',
    appearance: {
      sheet: { url: 'https://example.com/sheet.png?x=1', columns: 21, cellWidth: 32, cellHeight: 32 },
      entities: { W: { label: 'Warrior', sprite: { index: 17 }, image: 'https://example.com/wa.png' } }
    }
  });
  assert.ok(html.indexOf('--px:544') > 0, html);
  assert.ok(html.indexOf('--sheetw:672') > 0, html);
  assert.ok(html.indexOf('aria-label="Warrior"') > 0, html);
  assert.ok(html.indexOf('https://example.com/wa.png') < 0, 'lists use the sheet, not the big image');
});

check('qwerty for english and authored rows for dungleon', function () {
  const en = Pack.normalize(readPack('wordle-en.json'), readPack('wordle-en.json').variants[1]);
  const rows = Pack.keyboardRows(en);
  assert.deepStrictEqual(rows[0], ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p']);
  assert.deepStrictEqual(rows[2], ['z', 'x', 'c', 'v', 'b', 'n', 'm']);
  const dung = Pack.normalize(readPack('dungleon.json'), readPack('dungleon.json').variants[0]);
  const drows = Pack.keyboardRows(dung);
  assert.deepStrictEqual(drows[0], ['W', 'A', 'M', 'K', 'V']);
  assert.ok(drows[1].indexOf('S') >= 0 && drows[1].indexOf('s') >= 0);
  assert.notDeepStrictEqual(drows[0], rows[0]);
  const digits = Pack.keyboardRows(Pack.fromCustom({ length: 4, alphabet: '0123456789', caseInsensitive: false }));
  assert.deepStrictEqual(digits, [['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']]);
});

check('validator accepts the shipped playable packs and reports paths', function () {
  const en = Pack.validateManifest(readPack('wordle-en.json'));
  assert.strictEqual(en.ok, true, JSON.stringify(en.errors));
  const dung = Pack.validateManifest(readPack('dungleon.json'));
  assert.strictEqual(dung.ok, true, JSON.stringify(dung.errors));
  const nyt = Pack.validateManifest(readPack('wordle-nyt.json'));
  assert.strictEqual(nyt.ok, false);
  assert.ok(nyt.errors.some(function (e) { return e.path === 'remote'; }), JSON.stringify(nyt.errors));
  const sketch = Pack.validateManifest(readPack('mastermind-sketch.json'));
  assert.strictEqual(sketch.ok, false);
});

check('validator rejects scripts, bad urls, and bad lengths with paths', function () {
  const bad = Pack.validateManifest({
    id: 'nope',
    name: 'Nope',
    rules: 'script:https://evil.example/pwn.js',
    feedback: 'custom',
    pools: { theoretical: 'generated' },
    alphabet: 'ab',
    variants: [{
      id: 'nope',
      length: 0,
      knownSolutions: 'javascript:alert(1)'
    }],
    appearance: {
      entities: { a: { image: 'javascript:alert(1)', sprite: { index: 1 } } }
    },
    keyboard: { rows: [['a'], []] }
  });
  assert.strictEqual(bad.ok, false);
  const paths = bad.errors.map(function (e) { return e.path; });
  assert.ok(paths.indexOf('rules') >= 0, paths.join(','));
  assert.ok(paths.indexOf('pools.theoretical') >= 0, paths.join(','));
  assert.ok(paths.indexOf('variants[0].length') >= 0, paths.join(','));
  assert.ok(paths.indexOf('variants[0].knownSolutions') >= 0, paths.join(','));
  assert.ok(paths.indexOf('appearance.entities["a"].image') >= 0, paths.join(','));
  assert.ok(paths.indexOf('keyboard.rows[1]') >= 0, paths.join(','));
});

check('validator accepts an inline list and an https list', function () {
  const ok = Pack.validateManifest({
    id: 'mini',
    name: 'Mini',
    delimiter: 'none',
    caseInsensitive: true,
    rules: 'builtin:wordle',
    feedback: 'wordle',
    alphabet: 'abcdefghijklmnopqrstuvwxyz',
    pools: { theoretical: 'guessList' },
    variants: [{
      id: 'mini',
      name: 'Mini',
      length: 5,
      knownSolutions: ['crane', 'slate'],
      guessList: 'https://example.com/guesses.txt'
    }]
  });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.errors));
  assert.strictEqual(Pack.classifyList(['crane']).kind, 'array');
  assert.strictEqual(Pack.classifyList('https://example.com/guesses.txt').kind, 'url');
  assert.strictEqual(Pack.classifyList('english5-answers.txt').kind, 'file');
  assert.strictEqual(Pack.classifyList('../secret.txt').kind, 'bad');
  assert.strictEqual(Pack.classifyList('javascript:alert(1)').kind, 'bad');
});

check('relative image urls are kept and a forced sprite source skips the big image', function () {
  const pack = Pack.normalize({
    id: 'rel',
    name: 'Relative',
    alphabet: 'A',
    appearance: {
      keyboard: { source: 'sprite' },
      tiles: { source: 'image' },
      sheet: { url: 'packs/assets/sheet.png', cellWidth: 16, cellHeight: 16, columns: 2, rows: 1, gapX: 2, offsetX: 1 },
      entities: { A: { label: 'Aye', image: 'packs/assets/a.png', sprite: { col: 1, row: 0 } } }
    }
  }, { length: 1 });
  assert.strictEqual(pack.appearance.sheet.url, 'packs/assets/sheet.png');
  assert.strictEqual(pack.appearance.entities.A.image, 'packs/assets/a.png');
  assert.deepStrictEqual(pack.appearance.entities.A.sprite, { col: 1, row: 0 });
  assert.deepStrictEqual(Pack.cellOrigin(pack.appearance.sheet, 1, 0), { x: 1 + 16 + 2, y: 0 });
  const tiles = Renderers.tiles('tiles/letters', ['A'], null, { appearance: pack.appearance, showImages: true, surface: 'tiles' });
  const keys = Renderers.tiles('tiles/letters', ['A'], null, { appearance: pack.appearance, showImages: true, surface: 'keyboard' });
  assert.ok(tiles.indexOf('packs/assets/a.png') > 0, tiles);
  assert.ok(tiles.indexOf('sheet.png') < 0, tiles);
  assert.ok(keys.indexOf('sheet.png') > 0, keys);
  assert.ok(keys.indexOf('packs/assets/a.png') < 0, keys);
  const bad = Pack.normalize({
    id: 'js',
    name: 'Js',
    alphabet: 'A',
    appearance: { sheet: { url: 'javascript:alert(1)', cellWidth: 8, cellHeight: 8, columns: 1 }, entities: { A: { label: 'Aye', image: 'javascript:alert(1)' } } }
  }, { length: 1 });
  assert.strictEqual(bad.appearance.sheet, null);
  assert.strictEqual(bad.appearance.entities.A.image, undefined);
  assert.strictEqual(bad.appearance.entities.A.label, 'Aye');
});

check('images alias is accepted and a pack with no appearance stays unset', function () {
  const pack = Pack.normalize({
    id: 'alias',
    name: 'Alias',
    alphabet: 'ab',
    images: { entities: { a: { label: 'Ayy', image: 'https://example.com/a.png' } } }
  }, { length: 2 });
  assert.strictEqual(pack.appearance.entities.a.label, 'Ayy');
  const plain = Pack.normalize(readPack('wordle-en.json'), readPack('wordle-en.json').variants[0]);
  assert.strictEqual(plain.appearance, null);
  assert.strictEqual(plain.keyboard, null);
});

console.log(passed + ' checks passed');
