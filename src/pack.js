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
    var useLegacy = !pack.clueRenderer || pack.clueRenderer === 'clues/wordle-gyb';
    if (useLegacy) {
      Object.keys(LEGACY_CLUE).forEach(function (k) { map[k] = LEGACY_CLUE[k]; });
    }
    (pack.clueAlphabet || []).forEach(function (mark) {
      if (mark.label) map[normRaw(mark.label, { caseInsensitive: true })] = mark.value;
      (mark.symbols || []).forEach(function (s) {
        map[normRaw(s, { caseInsensitive: true })] = mark.value;
      });
    });
    return map;
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
      tokenRenderer: manifest.tokenRenderer || 'tiles/letters',
      clueRenderer: manifest.clueRenderer || 'clues/wordle-gyb',
      feedback: manifest.feedback || 'wordle',
      rules: manifest.rules || 'builtin:wordle',
      status: variant.status || manifest.status || 'ready',
      lists: {
        knownSolutions: variant.knownSolutions || null,
        guessList: variant.guessList || null,
        theoretical: (manifest.pools && manifest.pools.theoretical) || 'guessList'
      }
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

  Pack.digitsToPat = function (digits) {
    var p = 0, m = 1, i;
    for (i = 0; i < digits.length; i++, m *= 3) p += digits[i] * m;
    return p;
  };

  Pack.patToDigits = function (p, L) {
    var d = [], i;
    for (i = 0; i < L; i++) { d.push(p % 3); p = Math.floor(p / 3); }
    return d;
  };

  Pack.parseClue = function (text, pack) {
    if (!pack._clueMap) pack._clueMap = makeClueMap(pack);
    if (pack.clueShape === 'whole') {
      var whole = String(text == null ? '' : text).trim();
      if (!whole) return null;
      return { shape: 'whole', value: whole, slots: [], digits: null, pat: null };
    }
    var chars = Array.from(String(text == null ? '' : text).toLowerCase().replace(/[\s\uFE0F\u200D]/g, ''));
    var digits = [], i, v;
    for (i = 0; i < chars.length; i++) {
      v = pack._clueMap[chars[i]];
      if (v === undefined) return null;
      digits.push(v);
    }
    if (digits.length !== pack.length) return null;
    return {
      shape: 'perSlot',
      digits: digits,
      pat: Pack.digitsToPat(digits),
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
    return out;
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
