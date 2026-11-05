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

  function renderTiles(className) {
    return function (syms, digits, opts) {
      opts = opts || {};
      var cls = ['b', 'y', 'g'];
      var html = '<span class="tiles ' + className + '">';
      for (var i = 0; i < syms.length; i++) {
        var paint = digits ? (cls[digits[i]] || 'b') : 'e';
        var attr = opts.interactive ? ' data-i="' + i + '"' : '';
        html += '<span class="tile ' + paint + '"' + attr + '>' + esc(syms[i] || '·') + '</span>';
      }
      return html + '</span>';
    };
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
