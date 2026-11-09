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
      openers: copyOpeners(variant.openers != null ? variant.openers : manifest.openers)
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
      rulesImpl: opts.rulesImpl || null
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
