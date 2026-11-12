/* GamePack model: opaque tokens, list parsing, clue alphabets, validators.
 * A Word is a Token[]. Delimiters exist only while reading or printing text.
 * Browser: window.SolverPack. Node: module.exports.
 */
(function (root) {
  'use strict';

  var Pack = {};

  function normRaw(s, pack) {
    s = String(s);
    if (s.normalize) s = s.normalize('NFC');
    if (pack && pack.caseInsensitive) s = s.toLowerCase();
    return s;
  }

  function defaultClueAlphabet() {
    return [
      { id: 'absent', value: 0, label: 'B', symbols: ['b', 'r', 'x', 'w', 'a', '0', '-', '.', '_'] },
      { id: 'present', value: 1, label: 'Y', symbols: ['y', 'p', 'o', '1'] },
      { id: 'correct', value: 2, label: 'G', symbols: ['g', 'c', '2'] }
    ];
  }

  // Extra marks the page already accepted (emoji tiles, etc.).
  var LEGACY_CLUE = {
    g: 2, '2': 2, c: 2, '🟩': 2, '🟢': 2,
    y: 1, '1': 1, p: 1, o: 1, '🟨': 1, '🟧': 1, '🟡': 1,
    b: 0, r: 0, x: 0, w: 0, a: 0, '0': 0, '-': 0, '.': 0, '_': 0,
    '⬛': 0, '⬜': 0, '🟥': 0, '⚫': 0, '⚪': 0
  };

  function makeAlphabetSet(pack) {
    var a = pack.alphabet;
    if (a == null || a === '' || (Array.isArray(a) && !a.length)) return null;
    var arr;
    if (Array.isArray(a)) arr = a.map(function (t) { return normRaw(t, pack); });
    else if (pack.delimiter === 'none') arr = Array.from(normRaw(a, pack).replace(/\s+/g, ''));
    else arr = normRaw(a, pack).trim().split(/[\s,]+/).filter(Boolean);
    return arr.length ? new Set(arr) : null;
  }

  function makeClueMap(pack) {
    var map = {};
    var sensitive = !!(pack && pack.clueCaseSensitive);
    var useLegacy = !pack.clueRenderer || pack.clueRenderer === 'clues/wordle-gyb';
    if (useLegacy) {
      Object.keys(LEGACY_CLUE).forEach(function (k) { map[k] = LEGACY_CLUE[k]; });
    }
    function put(s, value) {
      if (s == null || s === '') return;
      var key = sensitive ? String(s) : normRaw(s, { caseInsensitive: true });
      map[key] = value;
    }
    (pack.clueAlphabet || []).forEach(function (mark) {
      put(mark.label, mark.value);
      (mark.symbols || []).forEach(function (s) { put(s, mark.value); });
    });
    return map;
  }

  // Pack-level only. true means three floors. An object may set floors
  // (integer 2..6). Anything else is ignored here; the checker reports it.
  function copyGauntlet(value) {
    var n;
    if (value == null || value === false) return null;
    if (value === true) return { floors: 3 };
    if (!ownObject(value)) return null;
    n = value.floors == null ? 3 : value.floors;
    if (!finiteNumber(n) || n < 2 || n > 6 || Math.floor(n) !== n) return null;
    return { floors: n };
  }

  function copyOpeners(list) {
    if (!list || !list.length) return [];
    var out = [];
    var i, w;
    for (i = 0; i < list.length; i++) {
      if (list[i] == null) continue;
      w = String(list[i]).trim();
      if (w) out.push(w);
    }
    return out;
  }

  // Image URLs from a pack are presentation only. http(s) or a relative
  // path. No scheme other than http(s), no "..", no markup.
  function isHttpUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2000) return false;
    if (/[\u0000-\u001f\u007f<>"'\\\s]/.test(value)) return false;
    return /^https?:\/\//i.test(value);
  }

  function isRelativeUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2000) return false;
    if (/[\u0000-\u001f\u007f<>"'\\\s]/.test(value)) return false;
    if (value.indexOf('//') === 0) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
    if (value.indexOf('..') >= 0) return false;
    return true;
  }

  function isPresentationUrl(value) {
    return isHttpUrl(value) || isRelativeUrl(value);
  }

  function artSource(block) {
    if (!ownObject(block)) return 'auto';
    if (block.source === 'sprite' || block.source === 'image' || block.source === 'auto') return block.source;
    return 'auto';
  }

  function finiteNumber(n) {
    return typeof n === 'number' && isFinite(n);
  }

  function ownObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  // appearance (alias: images) is optional. Tokens stay the data; this only
  // describes how to draw them. Unsafe URLs and bad cells are dropped.
  function nonNeg(n, fallback) {
    return finiteNumber(n) && n >= 0 ? n : fallback;
  }

  function spriteFrom(sp) {
    if (finiteNumber(sp)) {
      if (sp < 0 || Math.floor(sp) !== sp) return null;
      return { index: sp };
    }
    if (!ownObject(sp)) return null;
    if (finiteNumber(sp.index) && sp.index >= 0 && Math.floor(sp.index) === sp.index) return { index: sp.index };
    if (finiteNumber(sp.col) && finiteNumber(sp.row) && sp.col >= 0 && sp.row >= 0) return { col: sp.col, row: sp.row };
    if (finiteNumber(sp.x) && finiteNumber(sp.y) && sp.x >= 0 && sp.y >= 0) return { col: sp.x, row: sp.y };
    return null;
  }

  // appearance (alias: images) is optional. Tokens stay the data; this only
  // describes how to draw them. Unsafe URLs and bad cells are dropped.
  // keyboard.source / tiles.source: "auto" (image, then sprite, then the
  // letter), "image", or "sprite". A failed picture still falls back to the letter.
  function appearanceFrom(raw) {
    if (!ownObject(raw)) return null;
    var sheet = null;
    if (ownObject(raw.sheet) && isPresentationUrl(raw.sheet.url)) {
      var sw = finiteNumber(raw.sheet.cellWidth) ? raw.sheet.cellWidth : raw.sheet.width;
      var sh = finiteNumber(raw.sheet.cellHeight) ? raw.sheet.cellHeight : raw.sheet.height;
      var cols = raw.sheet.columns;
      if (finiteNumber(sw) && sw > 0 && finiteNumber(sh) && sh > 0 && finiteNumber(cols) && cols >= 1) {
        sheet = {
          url: raw.sheet.url,
          cellWidth: sw,
          cellHeight: sh,
          columns: Math.floor(cols),
          rows: (finiteNumber(raw.sheet.rows) && raw.sheet.rows >= 1) ? Math.floor(raw.sheet.rows) : 1,
          offsetX: nonNeg(raw.sheet.offsetX, 0),
          offsetY: nonNeg(raw.sheet.offsetY, 0),
          gapX: nonNeg(raw.sheet.gapX, 0),
          gapY: nonNeg(raw.sheet.gapY, 0)
        };
        if (Array.isArray(raw.sheet.cells)) {
          var cells = [];
          raw.sheet.cells.forEach(function (c) {
            if (typeof c === 'string') cells.push(c);
          });
          if (cells.length) sheet.cells = cells;
        }
      }
    }
    var entities = Object.create(null);
    var src = ownObject(raw.entities) ? raw.entities : null;
    if (src) {
      Object.keys(src).forEach(function (key) {
        if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') return;
        if (key.length > 80) return;
        var e = src[key];
        if (!ownObject(e)) return;
        var ent = {};
        if (typeof e.label === 'string' && e.label && e.label.length <= 80) ent.label = e.label;
        if (typeof e.title === 'string' && e.title && e.title.length <= 120) ent.title = e.title;
        if (isPresentationUrl(e.image)) ent.image = e.image;
        var sprite = spriteFrom(e.sprite);
        if (sprite) ent.sprite = sprite;
        if (ent.image || ent.sprite || ent.label || ent.title) entities[key] = ent;
      });
    }
    var keyboard = { source: artSource(raw.keyboard) };
    var tiles = { source: artSource(raw.tiles) };
    if (!sheet && !Object.keys(entities).length && keyboard.source === 'auto' && tiles.source === 'auto') return null;
    return { sheet: sheet, entities: entities, keyboard: keyboard, tiles: tiles };
  }

  function copyKeyboard(raw) {
    if (!ownObject(raw) || !Array.isArray(raw.rows)) return null;
    var rows = [];
    raw.rows.forEach(function (row) {
      if (!Array.isArray(row)) return;
      var keys = [];
      row.forEach(function (k) {
        if (typeof k !== 'string' || !k || k.length > 80) return;
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
        keys.push(k);
      });
      if (keys.length) rows.push(keys);
    });
    return rows.length ? { rows: rows } : null;
  }

  var QWERTY = [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm']
  ];

  var SHIPPED_RULES = { 'rules/wordle.js': 1, 'rules/dungleon.js': 1 };

  Pack.isHttpUrl = isHttpUrl;
  Pack.isPresentationUrl = isPresentationUrl;

  Pack.alphabetTokens = function (pack) {
    if (!pack) return [];
    var a = pack.alphabet;
    if (a == null || a === '' || (Array.isArray(a) && !a.length)) return [];
    if (Array.isArray(a)) {
      return a.map(function (t) { return String(t); }).filter(function (t) { return t.length > 0; });
    }
    if (!pack.delimiter || pack.delimiter === 'none') return Array.from(String(a).replace(/\s+/g, ''));
    return String(a).trim().split(/[\s,]+/).filter(Boolean);
  };

  // Authored rows win. A case-insensitive a–z alphabet uses QWERTY.
  // Anything else (Dungleon, digits, cards) keeps pack order, wrapped.
  Pack.keyboardRows = function (pack) {
    if (pack && pack.keyboard && pack.keyboard.rows && pack.keyboard.rows.length) {
      return pack.keyboard.rows.map(function (row) { return row.slice(); });
    }
    var tokens = Pack.alphabetTokens(pack);
    if (!tokens.length) return [];
    var folded = Object.create(null);
    var qwerty = pack.caseInsensitive !== false;
    var i, t;
    for (i = 0; i < tokens.length; i++) {
      t = tokens[i];
      if (!/^[a-z]$/i.test(t)) { qwerty = false; break; }
      if (folded[t.toLowerCase()]) { qwerty = false; break; }
      folded[t.toLowerCase()] = t;
    }
    if (qwerty && Object.keys(folded).length >= 20) {
      var rows = [];
      QWERTY.forEach(function (row) {
        var out = [];
        row.forEach(function (ch) {
          if (folded[ch]) out.push(pack.caseInsensitive === false ? folded[ch] : ch);
        });
        if (out.length) rows.push(out);
      });
      if (rows.length) return rows;
    }
    var width = tokens.length <= 12 ? tokens.length : (tokens.length <= 24 ? 8 : 10);
    var wrapped = [];
    for (i = 0; i < tokens.length; i += width) wrapped.push(tokens.slice(i, i + width));
    return wrapped;
  };

  Pack.sheetMetrics = function (sheet) {
    if (!sheet) return null;
    var cols = sheet.columns || 1;
    var rows = sheet.rows || 1;
    var cw = sheet.cellWidth || 32;
    var ch = sheet.cellHeight || cw;
    var gx = sheet.gapX || 0;
    var gy = sheet.gapY || 0;
    var ox = sheet.offsetX || 0;
    var oy = sheet.offsetY || 0;
    return {
      columns: cols,
      rows: rows,
      cellWidth: cw,
      cellHeight: ch,
      gapX: gx,
      gapY: gy,
      offsetX: ox,
      offsetY: oy,
      width: ox + cols * cw + Math.max(0, cols - 1) * gx,
      height: oy + rows * ch + Math.max(0, rows - 1) * gy
    };
  };

  Pack.cellOrigin = function (sheet, col, row) {
    var m = Pack.sheetMetrics(sheet);
    if (!m) return null;
    return {
      x: m.offsetX + col * (m.cellWidth + m.gapX),
      y: m.offsetY + row * (m.cellHeight + m.gapY)
    };
  };

  Pack.spriteCell = function (sprite, columns) {
    if (!sprite) return null;
    columns = columns || 1;
    if (finiteNumber(sprite.index)) {
      var index = Math.floor(sprite.index);
      if (index < 0 || columns < 1) return null;
      return { index: index, col: index % columns, row: Math.floor(index / columns) };
    }
    if (finiteNumber(sprite.col) && finiteNumber(sprite.row)) {
      return { index: null, col: sprite.col, row: sprite.row };
    }
    if (finiteNumber(sprite.x) && finiteNumber(sprite.y)) {
      return { index: null, col: sprite.x, row: sprite.y };
    }
    return null;
  };

  Pack.shippedRuleScript = function (rel) {
    return typeof rel === 'string' && !!SHIPPED_RULES[rel];
  };

  // A list reference inside a pack the editor can load.
  // file — a name under src/packs/ (built-in lists).
  // url — plain text fetched in the browser. Not the WordleBot host cache.
  // array — words written into the JSON.
  Pack.classifyList = function (value) {
    if (value == null || value === '') return { kind: 'empty' };
    if (Array.isArray(value)) return { kind: 'array' };
    if (typeof value !== 'string') return { kind: 'bad' };
    var s = value.trim();
    if (!s) return { kind: 'empty' };
    if (/^https?:\/\//i.test(s)) return isHttpUrl(s) ? { kind: 'url', url: s } : { kind: 'bad' };
    if (/^[A-Za-z0-9._/-]+$/.test(s) && s.indexOf('..') < 0 && s.indexOf('//') < 0 && s.charAt(0) !== '/') {
      return { kind: 'file', file: s };
    }
    return { kind: 'bad' };
  };

  function finish(pack) {
    if (!pack.clueAlphabet || !pack.clueAlphabet.length) pack.clueAlphabet = defaultClueAlphabet();
    pack.lists = pack.lists || { theoretical: 'guessList' };
    if (!pack.lists.theoretical) pack.lists.theoretical = 'guessList';
    pack.alphabetSet = makeAlphabetSet(pack);
    pack._clueMap = makeClueMap(pack);
    return pack;
  }

  Pack.defaultClueAlphabet = defaultClueAlphabet;

  Pack.normalize = function (manifest, variant) {
    variant = variant || {};
    var pack = {
      id: variant.id || manifest.id,
      name: variant.name || manifest.name,
      length: variant.length,
      alphabet: manifest.alphabet,
      caseInsensitive: manifest.caseInsensitive !== false,
      delimiter: manifest.delimiter || 'none',
      delimiterValue: manifest.delimiterValue || '-',
      clueShape: manifest.clueShape || 'perSlot',
      clueAlphabet: manifest.clueAlphabet || defaultClueAlphabet(),
      clueCaseSensitive: !!manifest.clueCaseSensitive,
      guessMode: variant.guessMode || manifest.guessMode || null,
      tokenRenderer: manifest.tokenRenderer || 'tiles/letters',
      clueRenderer: manifest.clueRenderer || 'clues/wordle-gyb',
      feedback: manifest.feedback || 'wordle',
      rules: manifest.rules || 'builtin:wordle',
      status: variant.status || manifest.status || 'ready',
      lists: {
        knownSolutions: variant.knownSolutions || null,
        guessList: variant.guessList || null,
        theoretical: (manifest.pools && manifest.pools.theoretical) || 'guessList'
      },
      // A variant array replaces the manifest list. Missing means inherit.
      // Empty means this variant authors none, so the page may generate.
      openers: copyOpeners(variant.openers != null ? variant.openers : manifest.openers),
      gauntlet: copyGauntlet(manifest.gauntlet),
      appearance: appearanceFrom(manifest.appearance || manifest.images),
      keyboard: copyKeyboard(manifest.keyboard)
    };
    return finish(pack);
  };

  Pack.fromCustom = function (opts) {
    opts = opts || {};
    var tokens = !!opts.tokens;
    var pack = {
      id: opts.id || 'custom',
      name: opts.name || 'Custom',
      length: opts.length,
      alphabet: opts.alphabet == null ? '' : opts.alphabet,
      caseInsensitive: !!opts.caseInsensitive,
      delimiter: opts.delimiter || (tokens ? 'charset' : 'none'),
      delimiterValue: opts.delimiterValue || '-',
      clueShape: opts.clueShape || 'perSlot',
      clueAlphabet: opts.clueAlphabet || defaultClueAlphabet(),
      tokenRenderer: opts.tokenRenderer || (tokens ? 'tiles/cards' : 'tiles/letters'),
      clueRenderer: opts.clueRenderer || 'clues/wordle-gyb',
      feedback: opts.rule === 'simple' ? 'simple' : 'wordle',
      rules: opts.rules || 'builtin:wordle',
      status: 'ready',
      lists: { theoretical: opts.theoretical || 'guessList' },
      openers: copyOpeners(opts.openers),
      rulesImpl: opts.rulesImpl || null,
      appearance: appearanceFrom(opts.appearance || opts.images),
      keyboard: copyKeyboard(opts.keyboard)
    };
    return finish(pack);
  };

  Pack.parseWord = function (raw, pack) {
    var s = normRaw(raw, pack).trim();
    if (!s) return [];
    if (pack.delimiter === 'none') return Array.from(s.replace(/\s+/g, ''));
    if (pack.delimiter === 'fixed') {
      return s.split(pack.delimiterValue || '-').map(function (t) { return t.trim(); }).filter(Boolean);
    }
    return s.split(/[\s,]+/).filter(Boolean);
  };

  Pack.formatWord = function (tokens, pack) {
    if (!tokens) return '';
    if (pack.delimiter === 'none') return tokens.join('');
    if (pack.delimiter === 'fixed') return tokens.join(pack.delimiterValue || '-');
    return tokens.join(' ');
  };

  Pack.splitEntries = function (text, pack) {
    if (!text) return [];
    if (pack.delimiter === 'none') return String(text).split(/[\s,;]+/).filter(Boolean);
    return String(text).split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
  };

  // base defaults to 3 so existing Wordle callers keep the same integers.
  Pack.digitsToPat = function (digits, base) {
    base = base || 3;
    var p = 0, m = 1, i;
    for (i = 0; i < digits.length; i++, m *= base) p += digits[i] * m;
    return p;
  };

  Pack.patToDigits = function (p, L, base) {
    base = base || 3;
    var d = [], i;
    for (i = 0; i < L; i++) { d.push(p % base); p = Math.floor(p / base); }
    return d;
  };

  // Radix and mark roles for a per-slot clue alphabet. Wordle's 0/1/2 alphabet
  // is base 3, correct digit 2. A longer alphabet (Dungleon is base 5) uses
  // max(value)+1. role "correct" locks a slot; "present" and "correct" count
  // as revealed copies. solve marks the all-green digit.
  Pack.clueModel = function (pack) {
    var marks = (pack && pack.clueAlphabet && pack.clueAlphabet.length) ? pack.clueAlphabet : defaultClueAlphabet();
    var max = 0, i, m, greenDigit = null;
    var correct = [], revealed = [];
    for (i = 0; i < marks.length; i++) {
      m = marks[i];
      if (typeof m.value === 'number' && m.value > max) max = m.value;
    }
    for (i = 0; i < marks.length; i++) {
      m = marks[i];
      if (m.solve) greenDigit = m.value;
    }
    if (greenDigit == null) {
      for (i = 0; i < marks.length; i++) {
        m = marks[i];
        if (m.plus) continue;
        if (m.role === 'correct' || m.value === 2) { greenDigit = m.value; break; }
      }
    }
    if (greenDigit == null) greenDigit = 2;
    for (i = 0; i < marks.length; i++) {
      m = marks[i];
      var role = m.role;
      if (!role) {
        if (m.value === 0) role = 'absent';
        else if (m.value === 2) role = 'correct';
        else if (m.value === 1) role = 'present';
      }
      if (role === 'correct') correct.push(m.value);
      if (role === 'present' || role === 'correct') revealed.push(m.value);
    }
    return {
      base: Math.max(2, max + 1),
      greenDigit: greenDigit,
      correctValues: correct,
      revealedValues: revealed
    };
  };

  Pack.parseClue = function (text, pack) {
    if (!pack._clueMap) pack._clueMap = makeClueMap(pack);
    if (pack.clueShape === 'whole') {
      var whole = String(text == null ? '' : text).trim();
      if (!whole) return null;
      return { shape: 'whole', value: whole, slots: [], digits: null, pat: null };
    }
    var raw = String(text == null ? '' : text).replace(/[\s\uFE0F\u200D]/g, '');
    var chars = pack.clueCaseSensitive ? Array.from(raw) : Array.from(raw.toLowerCase());
    var digits = [], i, v;
    var base = Pack.clueModel(pack).base;
    for (i = 0; i < chars.length; i++) {
      v = pack._clueMap[chars[i]];
      if (v === undefined) return null;
      digits.push(v);
    }
    if (digits.length !== pack.length) return null;
    return {
      shape: 'perSlot',
      digits: digits,
      pat: Pack.digitsToPat(digits, base),
      slots: digits.map(function (d) {
        var mark = null;
        (pack.clueAlphabet || []).forEach(function (m) { if (m.value === d) mark = m; });
        return mark ? mark.id : String(d);
      })
    };
  };

  function listMembership(word, ctx) {
    return ctx.structural(word) && ctx.inLists(word);
  }

  var BUILTIN_RULES = {
    wordle: function () {
      return {
        feedback: 'wordle',
        validGuess: listMembership,
        validSolution: listMembership,
        consistent: function (guess, clue, secret, ctx) {
          return ctx.pattern(guess, secret) === ctx.cluePattern(clue);
        },
        feedbackClue: function (guess, secret, ctx) {
          var pat = ctx.pattern(guess, secret);
          var digits = Pack.patToDigits(pat, ctx.pack.length);
          return Pack.parseClue(digits.map(function (d) { return String(d); }).join(''), ctx.pack) ||
            { shape: 'perSlot', digits: digits, pat: pat, slots: [] };
        }
      };
    },
    simple: function () {
      var base = BUILTIN_RULES.wordle();
      base.feedback = 'simple';
      return base;
    }
  };

  Pack.builtinRules = BUILTIN_RULES;

  // Best-effort escape hatch: the script body runs as a function with
  // `module` and `exports` only. It is not given a DOM or network helper.
  // It still shares the JavaScript realm (this is not a security boundary).
  Pack.evalRules = function (source) {
    var module = { exports: {} };
    var fn = new Function('module', 'exports', '"use strict";\n' + source + '\nreturn module.exports;');
    var out = fn(module, module.exports);
    if (!out || typeof out.validGuess !== 'function' || typeof out.validSolution !== 'function' || typeof out.consistent !== 'function') {
      throw new Error('Pack script must export validGuess, validSolution, and consistent');
    }
    out._source = source;
    return out;
  };

  // Turn a rules module into the optional Analysis hook. Missing feedbackKind
  // 'custom' returns null so Wordle keeps Core.feedback and base 3.
  // pat(g, go, a, ao, L, ...) matches Core.feedback's leading arguments.
  Pack.hooksFromRules = function (rules, meta) {
    if (!rules || rules.feedbackKind !== 'custom' || typeof rules.feedback !== 'function') return null;
    meta = meta || {};
    var base = meta.base || 3;
    var syms = meta.syms || [];
    var correct = null;
    var revealed = null;
    if (meta.correctValues && meta.correctValues.length) {
      correct = {};
      meta.correctValues.forEach(function (v) { correct[v] = 1; });
    }
    if (meta.revealedValues && meta.revealedValues.length) {
      revealed = {};
      meta.revealedValues.forEach(function (v) { revealed[v] = 1; });
    }
    return {
      base: base,
      greenDigit: meta.greenDigit == null ? 2 : meta.greenDigit,
      pat: function (g, go, a, ao, L) {
        if (typeof rules.feedbackIds === 'function') return rules.feedbackIds(g, go, a, ao, L);
        var guess = new Array(L);
        var secret = new Array(L);
        var i, p = 0, m = 1, clue, digits;
        for (i = 0; i < L; i++) {
          guess[i] = syms[g[go + i]];
          secret[i] = syms[a[ao + i]];
        }
        clue = rules.feedback(guess, secret, { pack: { length: L } });
        if (clue && typeof clue.pat === 'number') return clue.pat;
        digits = clue && clue.digits ? clue.digits : clue;
        for (i = 0; i < L; i++, m *= base) p += digits[i] * m;
        return p;
      },
      correct: correct ? function (digit) { return !!correct[digit]; } : null,
      revealed: revealed ? function (digit) { return !!revealed[digit]; } : null
    };
  };

  Pack.resolveRules = function (pack) {
    if (pack.rulesImpl) return pack.rulesImpl;
    var id = pack.rules || 'builtin:wordle';
    var name = id.indexOf('builtin:') === 0 ? id.slice('builtin:'.length) : id;
    var factory = BUILTIN_RULES[name] || BUILTIN_RULES.wordle;
    return factory(pack);
  };

  // fetchText(relativePath) -> Promise<string>. script: rules are evaluated
  // with Pack.evalRules; builtin: rules resolve immediately.
  Pack.loadRules = function (pack, fetchText) {
    var id = pack.rules || 'builtin:wordle';
    if (id.indexOf('script:') === 0) {
      if (typeof fetchText !== 'function') return Promise.reject(new Error('No fetch for ' + id));
      return fetchText(id.slice('script:'.length)).then(Pack.evalRules);
    }
    return Promise.resolve(Pack.resolveRules(pack));
  };

  var TOKEN_RENDERERS = { 'tiles/letters': 1, 'tiles/cards': 1, 'tiles/dungleon': 1 };
  var CLUE_RENDERERS = { 'clues/wordle-gyb': 1, 'clues/arrows-lr': 1, 'clues/mastermind-pips': 1 };
  var GUESS_MODES = { any: 1, dictionary: 1, hard: 1, answersOnly: 1 };
  var POOLS = { guessList: 1, known: 1, alphabet: 1, generated: 1 };
  var FEEDBACKS = { wordle: 1, simple: 1, custom: 1 };

  function pushMsg(list, path, message) {
    list.push({ path: path || '(pack)', message: message });
  }

  function isSafeKey(key) {
    return typeof key === 'string' && key && key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
  }

  // Live check for the Create tab. errors block Try it. warnings do not.
  // This never evaluates script text or fetches anything.
  Pack.validateManifest = function (manifest) {
    var errors = [];
    var warnings = [];
    if (!ownObject(manifest)) {
      pushMsg(errors, '(pack)', 'The pack must be a JSON object.');
      return { ok: false, errors: errors, warnings: warnings };
    }
    if (typeof manifest.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(manifest.id)) {
      pushMsg(errors, 'id', 'Use a short id of letters, digits, "_" or "-", starting with a letter or digit.');
    }
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
      pushMsg(errors, 'name', 'Give the pack a name.');
    } else if (manifest.name.length > 80) {
      pushMsg(errors, 'name', 'Name must be 80 characters or fewer.');
    }
    if (manifest.delimiter != null && manifest.delimiter !== 'none' && manifest.delimiter !== 'charset' && manifest.delimiter !== 'fixed') {
      pushMsg(errors, 'delimiter', 'delimiter must be "none", "charset", or "fixed".');
    }
    if (manifest.delimiter === 'fixed' && manifest.delimiterValue != null && typeof manifest.delimiterValue !== 'string') {
      pushMsg(errors, 'delimiterValue', 'delimiterValue must be a string.');
    }
    if (manifest.caseInsensitive != null && typeof manifest.caseInsensitive !== 'boolean') {
      pushMsg(errors, 'caseInsensitive', 'caseInsensitive must be true or false.');
    }
    if (manifest.clueCaseSensitive != null && typeof manifest.clueCaseSensitive !== 'boolean') {
      pushMsg(errors, 'clueCaseSensitive', 'clueCaseSensitive must be true or false.');
    }
    if (manifest.clueShape != null && manifest.clueShape !== 'perSlot' && manifest.clueShape !== 'whole' && manifest.clueShape !== 'mixed') {
      pushMsg(errors, 'clueShape', 'clueShape must be "perSlot", "whole", or "mixed".');
    }
    if (manifest.guessMode != null && !GUESS_MODES[manifest.guessMode]) {
      pushMsg(errors, 'guessMode', 'guessMode must be "any", "dictionary", "hard", or "answersOnly".');
    }
    if (manifest.feedback != null && !FEEDBACKS[manifest.feedback]) {
      pushMsg(errors, 'feedback', 'feedback must be "wordle", "simple", or "custom".');
    }
    if (manifest.tokenRenderer != null && !TOKEN_RENDERERS[manifest.tokenRenderer]) {
      pushMsg(warnings, 'tokenRenderer', 'Unknown tokenRenderer. The page will fall back to letter tiles.');
    }
    if (manifest.clueRenderer != null && !CLUE_RENDERERS[manifest.clueRenderer]) {
      pushMsg(warnings, 'clueRenderer', 'Unknown clueRenderer. The page will print each mark\'s label.');
    }

    var rules = manifest.rules == null ? 'builtin:wordle' : manifest.rules;
    var scriptRel = null;
    if (typeof rules !== 'string') {
      pushMsg(errors, 'rules', 'rules must be a string. Custom packs cannot embed JavaScript.');
    } else if (rules === 'builtin:wordle' || rules === 'builtin:simple') {
      scriptRel = null;
    } else if (rules.indexOf('script:') === 0) {
      scriptRel = rules.slice('script:'.length);
      if (!Pack.shippedRuleScript(scriptRel)) {
        pushMsg(errors, 'rules', 'Custom packs cannot run new JavaScript. script: may only name a rules file that ships with this site (rules/wordle.js or rules/dungleon.js).');
      }
    } else {
      pushMsg(errors, 'rules', 'rules must be "builtin:wordle", "builtin:simple", or a shipped script: path.');
    }
    if (manifest.feedback === 'custom' && !scriptRel) {
      pushMsg(errors, 'feedback', 'feedback "custom" needs a shipped rules script. builtin:wordle and builtin:simple score with the built-in marks.');
    }

    if (manifest.alphabet != null && typeof manifest.alphabet !== 'string' && !Array.isArray(manifest.alphabet)) {
      pushMsg(errors, 'alphabet', 'alphabet must be a string of characters or an array of tokens.');
    } else if (Array.isArray(manifest.alphabet)) {
      manifest.alphabet.forEach(function (tok, i) {
        if (typeof tok !== 'string' || !tok) pushMsg(errors, 'alphabet[' + i + ']', 'Each alphabet token must be a non-empty string.');
      });
    }

    var pool = 'guessList';
    if (manifest.pools != null && !ownObject(manifest.pools)) {
      pushMsg(errors, 'pools', 'pools must be an object.');
    } else if (manifest.pools && manifest.pools.theoretical != null) {
      pool = manifest.pools.theoretical;
      if (!POOLS[pool]) pushMsg(errors, 'pools.theoretical', 'pools.theoretical must be "guessList", "known", "alphabet", or "generated".');
    }
    if (pool === 'generated' && scriptRel !== 'rules/dungleon.js') {
      pushMsg(errors, 'pools.theoretical', 'generated solutions need the shipped Dungleon rules (script:rules/dungleon.js). A custom pack cannot supply its own generator.');
    }
    if (pool === 'alphabet') {
      pushMsg(warnings, 'pools.theoretical', 'alphabet is reserved. The engine does not expand alphabet^length yet.');
    }

    if (manifest.gauntlet != null && manifest.gauntlet !== false) {
      if (manifest.gauntlet !== true && !ownObject(manifest.gauntlet)) {
        pushMsg(errors, 'gauntlet', 'gauntlet must be true or an object with floors. It is pack-level, not a mode for every game.');
      } else if (manifest.gauntlet !== true) {
        var gFloors = manifest.gauntlet.floors == null ? 3 : manifest.gauntlet.floors;
        if (!finiteNumber(gFloors) || gFloors < 2 || gFloors > 6 || Math.floor(gFloors) !== gFloors) {
          pushMsg(errors, 'gauntlet.floors', 'floors must be an integer from 2 to 6.');
        }
      }
    }
    if (manifest.openers != null && !Array.isArray(manifest.openers)) {
      pushMsg(errors, 'openers', 'openers must be an array of guess strings.');
    } else if (Array.isArray(manifest.openers)) {
      manifest.openers.forEach(function (w, i) {
        if (typeof w !== 'string' || !w.trim()) pushMsg(errors, 'openers[' + i + ']', 'Each opener must be a non-empty string.');
      });
    }

    if (manifest.remote != null) {
      pushMsg(errors, 'remote', 'The WordleBot host cache (remote) is not available for a pack loaded from this editor. Use an https URL of a plain text word list, or an array of words. Nothing is uploaded, and JavaScript list files are not parsed here.');
    }

    function checkList(value, path, required) {
      if (value == null || value === '') {
        if (required) pushMsg(errors, path, 'Add a word list: an array of words, an https URL of a plain text list, or a file name that ships under src/packs/.');
        return;
      }
      var kind = Pack.classifyList(value);
      if (kind.kind === 'bad') {
        pushMsg(errors, path, 'Use an array of words, an http(s) URL of a plain text list (one word per line), or a file name under src/packs/. JavaScript URLs and ".." are not accepted.');
        return;
      }
      if (kind.kind === 'array') {
        if (!value.length) pushMsg(errors, path, 'This list is empty.');
        value.forEach(function (w, i) {
          if (typeof w !== 'string' || !String(w).trim()) pushMsg(errors, path + '[' + i + ']', 'Each entry must be a non-empty string.');
        });
        if (value.length > 80000) pushMsg(errors, path, 'This list is too long to load in the browser from the editor.');
      }
    }

    var variants = manifest.variants;
    if (variants == null) {
      if (!finiteNumber(manifest.length)) {
        pushMsg(errors, 'variants', 'Add a variants array, or a top-level length.');
      } else if (manifest.length < 1 || manifest.length > 20 || Math.floor(manifest.length) !== manifest.length) {
        pushMsg(errors, 'length', 'length must be an integer from 1 to 20.');
      }
      checkList(manifest.knownSolutions, 'knownSolutions', pool !== 'generated');
      if (manifest.guessList != null) checkList(manifest.guessList, 'guessList', false);
    } else if (!Array.isArray(variants) || !variants.length) {
      pushMsg(errors, 'variants', 'variants must be a non-empty array.');
    } else {
      variants.forEach(function (v, i) {
        var p = 'variants[' + i + ']';
        if (!ownObject(v)) { pushMsg(errors, p, 'Each variant must be an object.'); return; }
        if (v.id != null && (typeof v.id !== 'string' || !v.id.trim())) pushMsg(errors, p + '.id', 'Variant id must be a non-empty string.');
        if (v.name != null && typeof v.name !== 'string') pushMsg(errors, p + '.name', 'Variant name must be a string.');
        if (!finiteNumber(v.length) || v.length < 1 || v.length > 20 || Math.floor(v.length) !== v.length) {
          pushMsg(errors, p + '.length', 'length must be an integer from 1 to 20.');
        }
        if (v.guessMode != null && !GUESS_MODES[v.guessMode]) {
          pushMsg(errors, p + '.guessMode', 'guessMode must be "any", "dictionary", "hard", or "answersOnly".');
        }
        checkList(v.knownSolutions, p + '.knownSolutions', pool !== 'generated');
        if (v.guessList != null) checkList(v.guessList, p + '.guessList', false);
        if (v.openers != null && !Array.isArray(v.openers)) pushMsg(errors, p + '.openers', 'openers must be an array of strings.');
        if (v.gauntlet != null) pushMsg(warnings, p + '.gauntlet', 'gauntlet is pack-level. Put it next to the pack name; a variant cannot turn it on.');
      });
    }

    var look = ownObject(manifest.appearance) ? manifest.appearance : manifest.images;
    var lookPath = ownObject(manifest.appearance) ? 'appearance' : 'images';
    if (manifest.appearance != null && !ownObject(manifest.appearance)) {
      pushMsg(errors, 'appearance', 'appearance must be an object.');
    } else if (manifest.images != null && !ownObject(manifest.appearance) && !ownObject(manifest.images)) {
      pushMsg(errors, 'images', 'images must be an object. Prefer the appearance field.');
    }
    if (ownObject(look)) {
      var sheetOk = false;
      if (look.sheet != null && !ownObject(look.sheet)) {
        pushMsg(errors, lookPath + '.sheet', 'sheet must be an object with url, cellWidth, cellHeight, and columns.');
      } else if (ownObject(look.sheet)) {
        if (!isPresentationUrl(look.sheet.url)) pushMsg(errors, lookPath + '.sheet.url', 'Sprite sheet URL must be http(s) or a relative path. javascript: and data: are not used.');
        var cw = finiteNumber(look.sheet.cellWidth) ? look.sheet.cellWidth : look.sheet.width;
        var ch = finiteNumber(look.sheet.cellHeight) ? look.sheet.cellHeight : look.sheet.height;
        if (!finiteNumber(cw) || cw <= 0 || cw > 512) pushMsg(errors, lookPath + '.sheet.cellWidth', 'cellWidth must be a number from 1 to 512.');
        if (!finiteNumber(ch) || ch <= 0 || ch > 512) pushMsg(errors, lookPath + '.sheet.cellHeight', 'cellHeight must be a number from 1 to 512.');
        if (!finiteNumber(look.sheet.columns) || look.sheet.columns < 1 || Math.floor(look.sheet.columns) !== look.sheet.columns) {
          pushMsg(errors, lookPath + '.sheet.columns', 'columns must be a positive integer.');
        }
        sheetOk = isPresentationUrl(look.sheet.url) && finiteNumber(cw) && cw > 0 && finiteNumber(ch) && ch > 0 && finiteNumber(look.sheet.columns) && look.sheet.columns >= 1;
        ['offsetX', 'offsetY', 'gapX', 'gapY'].forEach(function (name) {
          if (look.sheet[name] != null && (!finiteNumber(look.sheet[name]) || look.sheet[name] < 0)) {
            pushMsg(errors, lookPath + '.sheet.' + name, name + ' must be a number >= 0.');
          }
        });
        if (look.sheet.rows != null && (!finiteNumber(look.sheet.rows) || look.sheet.rows < 1 || Math.floor(look.sheet.rows) !== look.sheet.rows)) {
          pushMsg(errors, lookPath + '.sheet.rows', 'rows must be a positive integer.');
        }
        if (look.sheet.cells != null && !Array.isArray(look.sheet.cells)) {
          pushMsg(errors, lookPath + '.sheet.cells', 'cells must be an array of names, one per cell, in sheet order.');
        }
      }
      function checkArtSource(block, path) {
        if (block == null) return;
        if (!ownObject(block)) { pushMsg(errors, path, 'must be an object with source "auto", "sprite", or "image".'); return; }
        if (block.source != null && block.source !== 'auto' && block.source !== 'sprite' && block.source !== 'image') {
          pushMsg(errors, path + '.source', 'source must be "auto", "sprite", or "image".');
        }
      }
      checkArtSource(look.keyboard, lookPath + '.keyboard');
      checkArtSource(look.tiles, lookPath + '.tiles');
      if (look.entities != null && !ownObject(look.entities)) {
        pushMsg(errors, lookPath + '.entities', 'entities must be an object keyed by alphabet token.');
      } else if (ownObject(look.entities)) {
        var entKeys = Object.keys(look.entities);
        if (!entKeys.length) pushMsg(warnings, lookPath + '.entities', 'No entities are defined. Tiles will stay letters.');
        entKeys.forEach(function (key) {
          var ep = lookPath + '.entities[' + JSON.stringify(key) + ']';
          if (!isSafeKey(key)) { pushMsg(errors, ep, 'That entity key is not allowed.'); return; }
          var e = look.entities[key];
          if (!ownObject(e)) { pushMsg(errors, ep, 'Each entity must be an object.'); return; }
          if (e.label != null && typeof e.label !== 'string') pushMsg(errors, ep + '.label', 'label must be a string.');
          if (e.title != null && typeof e.title !== 'string') pushMsg(errors, ep + '.title', 'title must be a string.');
          if (!e.label && !e.title) pushMsg(warnings, ep + '.label', 'Add a label so the picture has accessible text and a tooltip.');
          if (e.image != null && !isPresentationUrl(e.image)) pushMsg(errors, ep + '.image', 'image must be an http(s) URL or a relative path. The letter is shown if you omit it.');
          var wantsSheet = false;
          if (e.sprite != null && !spriteFrom(e.sprite)) {
            pushMsg(errors, ep + '.sprite', 'sprite must be { index }, { col, row }, or { x, y } cell coordinates, not pixels.');
          } else if (spriteFrom(e.sprite)) {
            wantsSheet = true;
            var sp = e.sprite;
            var index = finiteNumber(sp) ? sp : (ownObject(sp) ? sp.index : null);
            if (index != null && sheetOk && look.sheet.rows && index >= look.sheet.columns * look.sheet.rows) {
              pushMsg(errors, ep + '.sprite.index', 'index is past this sheet.');
            }
          }
          if (wantsSheet && !ownObject(look.sheet)) {
            pushMsg(errors, lookPath + '.sheet', 'A sprite cell needs appearance.sheet (url, cell size, columns).');
          }
          if (e.image == null && e.sprite == null && e.label == null && e.title == null) {
            pushMsg(errors, ep, 'Give the entity a label, an image URL, or a sprite cell.');
          }
        });
      }
    }

    if (manifest.keyboard != null && !ownObject(manifest.keyboard)) {
      pushMsg(errors, 'keyboard', 'keyboard must be an object.');
    } else if (ownObject(manifest.keyboard)) {
      if (!Array.isArray(manifest.keyboard.rows) || !manifest.keyboard.rows.length) {
        pushMsg(errors, 'keyboard.rows', 'keyboard.rows must be an array of rows, each an array of alphabet tokens.');
      } else {
        var seen = Object.create(null);
        manifest.keyboard.rows.forEach(function (row, r) {
          if (!Array.isArray(row) || !row.length) {
            pushMsg(errors, 'keyboard.rows[' + r + ']', 'Each row must be a non-empty array of tokens.');
            return;
          }
          row.forEach(function (k, c) {
            var kp = 'keyboard.rows[' + r + '][' + c + ']';
            if (typeof k !== 'string' || !k) { pushMsg(errors, kp, 'Each key must be a non-empty string, exactly as it is typed.'); return; }
            if (seen[k]) pushMsg(warnings, kp, 'This token is already on the keyboard.');
            seen[k] = 1;
          });
        });
      }
    }

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  };

  Pack.consistentAll = function (rules, history, secret, ctx) {
    var i;
    for (i = 0; i < history.length; i++) {
      if (!rules.consistent(history[i].guess, history[i].clue, secret, ctx)) return false;
    }
    return true;
  };

  root.SolverPack = Pack;
  if (typeof module !== 'undefined' && module.exports) module.exports = Pack;
})(typeof self !== 'undefined' ? self : this);
