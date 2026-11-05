/* SolverEngine: pools, history, guess modes, and Wordle-style scoring.
 * Browser: window.SolverEngine. Node: module.exports.
 *
 * Solution layers
 *   known        — pack knownSolutions still consistent with history
 *   theoretical  — dictionary (or other theoretical source) still consistent
 *   preferred    — known while any remain, otherwise theoretical
 *
 * Guess modes (one pack, not separate games)
 *   any          — any tokens of pack length over the alphabet (suggestions stay on the lists; alphabet^n is not expanded)
 *   dictionary   — validGuess (listed words)
 *   hard         — validGuess and consistentAll, treating the candidate as the secret
 *   answersOnly  — still inside the active remaining layer
 *
 * The legacy valid / hard / ansOnly controls map onto those modes. Wordle hard
 * (reuse greens and yellows) is a weaker extra filter than guess mode "hard".
 */
(function (root) {
  'use strict';

  var Core = root.SolverCore;
  var Pack = root.SolverPack;
  if (!Core && typeof require === 'function') Core = require('./core.js');
  if (!Pack && typeof require === 'function') Pack = require('./pack.js');

  var Engine = {};

  function create(pack, lists) {
    lists = lists || {};
    var L = pack.length;
    var eng = {
      pack: pack,
      keys: [],
      tokens: [],
      keyIdx: new Map(),
      flags: [],
      syms: [],
      symId: new Map(),
      rej: 0,
      dup: 0,
      nKnown: 0,
      nWords: 0,
      knownIdx: [],
      theoreticalIdx: [],
      guessIdx: [],
      U: null,
      feedbackRule: pack.feedback || 'wordle',
      rules: null,
      _counts: new Int16Array(64),
      _pow3: Core.pow3(L)
    };

    function symIdOf(s) {
      var id = eng.symId.get(s);
      if (id === undefined) {
        id = eng.syms.length;
        eng.symId.set(s, id);
        eng.syms.push(s);
      }
      return id;
    }
    eng.symIdOf = symIdOf;

    function ensureCounts() {
      if (eng._counts.length < eng.syms.length + 2) eng._counts = new Int16Array(eng.syms.length + 64);
    }

    var theoFrom = (pack.lists && pack.lists.theoretical) || 'guessList';

    function add(raw, kind) {
      var tokens = Pack.parseWord(raw, pack);
      if (!tokens.length) return;
      if (tokens.length !== L) { eng.rej++; return; }
      if (pack.alphabetSet) {
        for (var i = 0; i < L; i++) if (!pack.alphabetSet.has(tokens[i])) { eng.rej++; return; }
      }
      var key = Pack.formatWord(tokens, pack);
      var idx = eng.keyIdx.get(key);
      if (idx === undefined) {
        idx = eng.keys.length;
        eng.keyIdx.set(key, idx);
        eng.keys.push(key);
        eng.tokens.push(tokens);
        eng.flags.push({ known: false, theoretical: false, guess: false });
        for (var t = 0; t < tokens.length; t++) symIdOf(tokens[t]);
      } else eng.dup++;
      var f = eng.flags[idx];
      if (kind === 'known') {
        f.known = true;
        f.guess = true;
        f.theoretical = true;
      } else {
        f.guess = true;
        if (theoFrom === 'guessList') f.theoretical = true;
      }
    }

    Pack.splitEntries(lists.answers, pack).forEach(function (w) { add(w, 'known'); });
    Pack.splitEntries(lists.guesses, pack).forEach(function (w) { add(w, 'guess'); });
    eng.nWords = eng.keys.length;

    eng.U = new Uint16Array(Math.max(1, eng.nWords) * L);
    eng.tokens.forEach(function (row, i) {
      for (var j = 0; j < L; j++) eng.U[i * L + j] = eng.symId.get(row[j]);
    });

    eng.structural = function (word) {
      if (!word || word.length !== L) return false;
      if (!pack.alphabetSet) return true;
      for (var i = 0; i < word.length; i++) if (!pack.alphabetSet.has(word[i])) return false;
      return true;
    };
    eng.inLists = function (word) {
      if (!word || !word.length) return false;
      return eng.keyIdx.has(Pack.formatWord(word, pack));
    };
    eng.pattern = function (guess, secret) {
      var g = idsOf(guess), s = idsOf(secret);
      ensureCounts();
      return Core.feedback(g, 0, s, 0, L, eng.feedbackRule, eng._counts, eng._pow3);
    };
    eng.cluePattern = function (clue) {
      if (!clue) return null;
      if (typeof clue.pat === 'number') return clue.pat;
      if (clue.digits) return Pack.digitsToPat(clue.digits);
      return null;
    };

    function idsOf(tokens) {
      var ids = new Uint16Array(tokens.length);
      for (var i = 0; i < tokens.length; i++) ids[i] = symIdOf(tokens[i]);
      return ids;
    }

    eng.rules = Pack.resolveRules(pack);
    if (!pack.feedback && eng.rules.feedback) eng.feedbackRule = eng.rules.feedback;

    for (var i = 0; i < eng.flags.length; i++) {
      var f = eng.flags[i];
      if (f.known) eng.knownIdx.push(i);
      if (f.guess) eng.guessIdx.push(i);
      if (f.theoretical && eng.rules.validSolution(eng.tokens[i], eng)) eng.theoreticalIdx.push(i);
      else f.theoretical = false;
    }
    eng.nKnown = eng.knownIdx.length;

    eng.feedbackPat = function (ids, idx) {
      ensureCounts();
      return Core.feedback(ids, 0, eng.U, idx * L, L, eng.feedbackRule, eng._counts, eng._pow3);
    };

    eng.feedbackDigits = function (guessRaw, secretRaw) {
      var guess = typeof guessRaw === 'string' ? Pack.parseWord(guessRaw, pack) : guessRaw;
      var secret = typeof secretRaw === 'string' ? Pack.parseWord(secretRaw, pack) : secretRaw;
      return Pack.patToDigits(eng.pattern(guess, secret), L);
    };

    eng.encode = function (raw) {
      var tokens = Pack.parseWord(raw, pack);
      if (tokens.length !== L) {
        return { err: 'needs ' + L + (pack.delimiter === 'none' ? ' letters' : ' tokens') + ' (got ' + tokens.length + ')' };
      }
      if (pack.alphabetSet) {
        for (var i = 0; i < tokens.length; i++) {
          if (!pack.alphabetSet.has(tokens[i])) return { err: '"' + tokens[i] + '" is not in the alphabet' };
        }
      }
      return { key: Pack.formatWord(tokens, pack), ids: tokens.map(symIdOf), syms: tokens, word: tokens };
    };

    eng.makeClue = function (raw, digits) {
      var g = eng.encode(raw);
      if (g.err) return g;
      var pat = Pack.digitsToPat(digits);
      var slots = digits.map(function (d) {
        var mark = null;
        (pack.clueAlphabet || []).forEach(function (m) { if (m.value === d) mark = m; });
        return mark ? mark.id : String(d);
      });
      return {
        key: g.key,
        ids: g.ids,
        syms: g.syms,
        digits: digits.slice(),
        pat: pat,
        word: g.word,
        clue: { shape: 'perSlot', slots: slots, digits: digits.slice(), pat: pat }
      };
    };

    eng.consistentAll = function (secret, history) {
      return Pack.consistentAll(eng.rules, history, secret, eng);
    };

    eng.consistentAllIndex = function (idx, clues) {
      for (var c = 0; c < clues.length; c++) {
        if (eng.feedbackPat(clues[c].ids, idx) !== clues[c].pat) return false;
      }
      return true;
    };

    eng.wordleHardOk = function (idx, clues) {
      var base = idx * L, c, i, cl, need, ok;
      for (c = 0; c < clues.length; c++) {
        cl = clues[c];
        need = new Map();
        for (i = 0; i < L; i++) {
          if (cl.digits[i] === 2 && eng.U[base + i] !== cl.ids[i]) return false;
          if (cl.digits[i] > 0) need.set(cl.ids[i], (need.get(cl.ids[i]) || 0) + 1);
        }
        ok = true;
        need.forEach(function (n, s) {
          var have = 0, j;
          for (j = 0; j < L; j++) if (eng.U[base + j] === s) have++;
          if (have < n) ok = false;
        });
        if (!ok) return false;
      }
      return true;
    };

    eng.partition = function (clues) {
      var known = [], theoretical = [], i, idx;
      for (i = 0; i < eng.knownIdx.length; i++) {
        idx = eng.knownIdx[i];
        if (eng.consistentAllIndex(idx, clues)) known.push(idx);
      }
      for (i = 0; i < eng.theoreticalIdx.length; i++) {
        idx = eng.theoreticalIdx[i];
        if (eng.consistentAllIndex(idx, clues)) theoretical.push(idx);
      }
      return { known: known, theoretical: theoretical };
    };

    eng.activeRemaining = function (layer, parts) {
      if (layer === 'theoretical') return parts.theoretical;
      if (layer === 'preferred') return parts.known.length ? parts.known : parts.theoretical;
      return parts.known;
    };

    eng.replay = function (clues, layer) {
      var known = eng.knownIdx.slice();
      var theoretical = eng.theoreticalIdx.slice();
      clues.forEach(function (c) {
        known = known.filter(function (r) { return eng.feedbackPat(c.ids, r) === c.pat; });
        theoretical = theoretical.filter(function (r) { return eng.feedbackPat(c.ids, r) === c.pat; });
        c.afterKnown = known.length;
        c.afterTheo = theoretical.length;
        if (layer === 'theoretical') c.after = theoretical.length;
        else if (layer === 'preferred' && !known.length) c.after = theoretical.length;
        else c.after = known.length;
      });
      return { known: known, theoretical: theoretical };
    };

    eng.validityNote = function (key, cfg) {
      cfg = cfg || {};
      if (cfg.valid === 'any' || cfg.guessMode === 'any') return '';
      var idx = eng.keyIdx.get(key);
      if (idx === undefined) return 'not in ' + (cfg.valid === 'answers' ? 'answer list' : 'word lists');
      if (cfg.valid === 'answers' && !eng.flags[idx].known) return 'not in answer list';
      return '';
    };

    eng.guessMode = function (cfg) {
      if (cfg.guessMode) return cfg.guessMode;
      if (cfg.ansOnly) return 'answersOnly';
      if (cfg.hard === 'strict') return 'hard';
      if (cfg.valid === 'any') return 'any';
      return 'dictionary';
    };

    eng.buildPool = function (opts) {
      var mode = eng.guessMode(opts);
      var pool = [], i, total, pruned = false;
      if (opts.ansOnly || mode === 'answersOnly') pool = opts.remaining.slice();
      else if (opts.valid === 'answers' && mode !== 'hard' && mode !== 'any') pool = eng.knownIdx.slice();
      else if (mode === 'hard') {
        var source = opts.valid === 'answers' ? eng.knownIdx : null;
        var nSrc = source ? source.length : eng.nWords;
        for (i = 0; i < nSrc; i++) {
          var idx = source ? source[i] : i;
          if (eng.rules.validGuess(eng.tokens[idx], eng) && eng.consistentAllIndex(idx, opts.clues)) pool.push(idx);
        }
      } else {
        for (i = 0; i < eng.nWords; i++) pool.push(i);
      }
      if (opts.hard === 'wordle') pool = pool.filter(function (idx) { return eng.wordleHardOk(idx, opts.clues); });
      else if (opts.hard === 'strict' && mode !== 'hard') pool = pool.filter(function (idx) { return eng.consistentAllIndex(idx, opts.clues); });
      total = pool.length;
      if (pool.length > opts.max) {
        pool = prunePool(pool, opts.remaining, opts.max);
        pruned = true;
      }
      return { pool: pool, pruned: pruned, total: total, mode: mode };
    };

    function prunePool(pool, remaining, max) {
      var K = eng.syms.length, n = remaining.length;
      var pres = new Float64Array(K), pos = new Float64Array(K * L), seen = new Int32Array(K);
      for (var s = 0; s < K; s++) seen[s] = -1;
      remaining.forEach(function (r, ri) {
        for (var i = 0; i < L; i++) {
          var sym = eng.U[r * L + i];
          pos[sym * L + i]++;
          if (seen[sym] !== ri) { seen[sym] = ri; pres[sym]++; }
        }
      });
      var remSet = new Set(remaining);
      var cands = [], others = [];
      pool.forEach(function (gi) {
        var h = 0, used = new Set(), i, sym, pf;
        for (i = 0; i < L; i++) {
          sym = eng.U[gi * L + i];
          pf = pos[sym * L + i];
          h += 0.5 * Math.min(pf, n - pf);
          if (!used.has(sym)) { used.add(sym); h += Math.min(pres[sym], n - pres[sym]); }
        }
        (remSet.has(gi) ? cands : others).push({ gi: gi, h: h });
      });
      var byH = function (a, b) { return b.h - a.h; };
      cands.sort(byH);
      others.sort(byH);
      var keepC = cands.slice(0, Math.floor(max / 2));
      var keepO = others.slice(0, max - keepC.length);
      if (keepO.length < max - keepC.length) keepC = cands.slice(0, max - keepO.length);
      return keepC.concat(keepO).map(function (x) { return x.gi; });
    }

    return eng;
  }

  Engine.create = create;
  root.SolverEngine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
})(typeof self !== 'undefined' ? self : this);
