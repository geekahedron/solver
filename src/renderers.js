/* tokenRenderer / clueRenderer ids. The page draws with these; art can replace them later.
 * Browser: window.SolverRenderers. Node: module.exports.
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function paintClass(digit, opts) {
    var marks = opts && opts.marks;
    var i, m;
    if (marks) {
      for (i = 0; i < marks.length; i++) {
        m = marks[i];
        if (m.value === digit && m.paint) return m.paint;
      }
    }
    return ['b', 'y', 'g'][digit] || 'b';
  }

  function httpUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2000) return false;
    if (/[\u0000-\u001f\u007f<>"'\\\s]/.test(value)) return false;
    return /^https?:\/\//i.test(value);
  }

  function entityOf(sym, opts) {
    var app = opts && opts.appearance;
    if (!app || !app.entities || sym == null || sym === '') return null;
    return app.entities[sym] || null;
  }

  function entityLabel(sym, ent) {
    if (ent && ent.label) return ent.label;
    if (ent && ent.title) return ent.title;
    return sym == null ? '' : String(sym);
  }

  function entityTitle(sym, ent) {
    var label = entityLabel(sym, ent);
    var title = (ent && ent.title) || label;
    if (sym && title && title !== sym) return title + ' (' + sym + ')';
    return title || (sym == null ? '' : String(sym));
  }

  function spriteCell(sprite, columns) {
    if (!sprite || !columns || columns < 1) return null;
    if (typeof sprite.index === 'number' && isFinite(sprite.index)) {
      var index = Math.floor(sprite.index);
      if (index < 0) return null;
      return { col: index % columns, row: Math.floor(index / columns) };
    }
    if (typeof sprite.x === 'number' && typeof sprite.y === 'number' && isFinite(sprite.x) && isFinite(sprite.y)) {
      if (sprite.x < 0 || sprite.y < 0) return null;
      return { col: sprite.x, row: sprite.y };
    }
    return null;
  }

  // Sprite sheet for small keys and lists. Big image for clue tiles.
  // A missing picture leaves the letter in the tile; the page hides it
  // until the image errors.
  function pickArt(sym, opts) {
    if (!opts || opts.showImages === false || !sym) return null;
    var ent = entityOf(sym, opts);
    if (!ent) return null;
    var sheet = opts.appearance && opts.appearance.sheet;
    var want = opts.art || 'image';
    var spriteOk = !!(ent.sprite && sheet && httpUrl(sheet.url) && spriteCell(ent.sprite, sheet.columns));
    var imageOk = !!(ent.image && httpUrl(ent.image));
    if (want === 'sprite') {
      if (spriteOk) return { kind: 'sprite', ent: ent };
      if (imageOk) return { kind: 'image', ent: ent };
    } else {
      if (imageOk) return { kind: 'image', ent: ent };
      if (spriteOk) return { kind: 'sprite', ent: ent };
    }
    if (ent.label || ent.title) return { kind: 'label', ent: ent };
    return null;
  }

  function spriteHTML(ent, sheet) {
    var cell = spriteCell(ent.sprite, sheet.columns);
    if (!cell) return '';
    var cols = Math.floor(sheet.columns);
    var col = Math.floor(cell.col);
    var row = Math.floor(cell.row);
    return '<span class="entity-sprite" style="--col:' + col + ';--row:' + row + ';--cols:' + cols + '">' +
      '<img class="entity-img" alt="" src="' + esc(sheet.url) + '"></span>';
  }

  function imageHTML(ent, alt) {
    return '<img class="entity-img entity-photo" alt="' + esc(alt) + '" src="' + esc(ent.image) + '">';
  }

  function artInner(sym, art, opts) {
    if (!art || art.kind === 'label') return esc(sym);
    var label = entityLabel(sym, art.ent);
    var face = art.kind === 'sprite' ? spriteHTML(art.ent, opts.appearance.sheet) : imageHTML(art.ent, label);
    if (!face) return esc(sym);
    return face + '<span class="entity-letter" aria-hidden="true">' + esc(sym) + '</span>';
  }

  function renderTiles(className) {
    return function (syms, digits, opts) {
      opts = opts || {};
      var html = '<span class="tiles ' + className + '">';
      for (var i = 0; i < syms.length; i++) {
        var sym = syms[i] || '';
        var paint = digits ? paintClass(digits[i], opts) : 'e';
        var attr = opts.interactive ? ' data-i="' + i + '"' : '';
        var art = sym ? pickArt(sym, opts) : null;
        var title = '';
        var aria = '';
        if (art) {
          var named = entityTitle(sym, art.ent);
          title = ' title="' + esc(named) + '"';
          aria = ' aria-label="' + esc(named) + '"';
        }
        var inner = sym ? artInner(sym, art, opts) : '·';
        html += '<span class="tile ' + paint + '"' + attr + title + aria + '>' + inner + '</span>';
      }
      return html + '</span>';
    };
  }

  function wordArt(tokens, opts) {
    opts = opts || {};
    var local = {};
    var k;
    for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) local[k] = opts[k];
    local.art = opts.art || 'sprite';
    var names = [];
    var html = '<span class="word-art"' + (opts.title ? ' title="' + esc(opts.title) + '"' : '') + '>';
    for (var i = 0; i < tokens.length; i++) {
      var sym = tokens[i];
      var art = pickArt(sym, local);
      names.push(art ? entityLabel(sym, art.ent) : String(sym));
      if (!art || art.kind === 'label') {
        html += '<span class="mini-tile">' + esc(sym) + '</span>';
        continue;
      }
      html += '<span class="mini-tile" title="' + esc(entityTitle(sym, art.ent)) + '">' + artInner(sym, art, local) + '</span>';
    }
    html += '</span>';
    if (names.length) {
      html = html.replace('<span class="word-art"', '<span class="word-art" aria-label="' + esc(names.join(' ')) + '"');
    }
    return html;
  }

  function entityFace(sym, opts) {
    opts = opts || {};
    var art = pickArt(sym, opts);
    if (!art || art.kind === 'label') return '';
    if (opts.caption === false) {
      if (art.kind === 'sprite') return spriteHTML(art.ent, opts.appearance.sheet);
      return imageHTML(art.ent, '');
    }
    return artInner(sym, art, opts);
  }

  var NOT = {
    GYB: ['B', 'Y', 'G'],
    gyr: ['r', 'y', 'g'],
    '210': ['0', '1', '2'],
    emoji: ['⬛', '🟨', '🟩']
  };

  var registry = {
    'tiles/letters': renderTiles('letters'),
    'tiles/cards': renderTiles('cards'),
    'tiles/dungleon': renderTiles('glyph')
  };

  function tiles(id, syms, digits, opts) {
    var fn = registry[id] || registry['tiles/letters'];
    return fn(syms, digits, opts);
  }

  function clueCode(id, digits, notation, pack) {
    var i, mark;
    if (!id || id === 'clues/wordle-gyb') {
      if (pack && pack.clueAlphabet && pack.clueAlphabet.length > 3) {
        return digits.map(function (x) {
          var mark = null;
          pack.clueAlphabet.forEach(function (m) { if (m.value === x) mark = m; });
          return mark ? mark.label : String(x);
        }).join('');
      }
      var n = NOT[notation] || NOT.GYB;
      return digits.map(function (x) { return n[x] == null ? n[0] : n[x]; }).join('');
    }
    if (id === 'clues/arrows-lr') {
      var arrows = ['·', '←', '→'];
      return digits.map(function (x) { return arrows[x] || '·'; }).join('');
    }
    if (id === 'clues/mastermind-pips') {
      var black = 0, white = 0;
      for (i = 0; i < digits.length; i++) {
        if (digits[i] === 2) black++;
        else if (digits[i] === 1) white++;
      }
      return black + 'B' + white + 'W';
    }
    var out = '';
    for (i = 0; i < digits.length; i++) {
      mark = null;
      if (pack && pack.clueAlphabet) {
        pack.clueAlphabet.forEach(function (m) { if (m.value === digits[i]) mark = m; });
      }
      out += mark ? mark.label : String(digits[i]);
    }
    return out;
  }

  var api = {
    registry: registry,
    tiles: tiles,
    wordArt: wordArt,
    entityFace: entityFace,
    clueCode: clueCode,
    esc: esc,
    ids: {
      tokens: ['tiles/letters', 'tiles/cards', 'tiles/dungleon'],
      clues: ['clues/wordle-gyb', 'clues/arrows-lr', 'clues/mastermind-pips']
    }
  };

  root.SolverRenderers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
