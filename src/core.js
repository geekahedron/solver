/* Wordle-style solver core — shared by the page (app.js) and the Web Worker (worker.js).
 * Words are encoded as flat Uint16Array of symbol ids (L symbols per word).
 * Feedback patterns are base-3 integers: digit i = 0 gray, 1 yellow, 2 green (position 0 = least significant). */
(function (root) {
  'use strict';
  var Core = {};

  // Compute feedback for guess (array-like g, offset go) vs answer (a, offset ao).
  // rule: 'wordle' (standard duplicate handling) | 'simple' (any present letter -> yellow).
  // counts: scratch Int16Array sized >= max symbol id + 1, must be all zero; left all zero.
  Core.feedback = function (g, go, a, ao, L, rule, counts, pow3) {
    var pat = 0, i, gs;
    if (rule === 'simple') {
      for (i = 0; i < L; i++) counts[a[ao + i]] = 1;
      for (i = 0; i < L; i++) {
        gs = g[go + i];
        if (gs === a[ao + i]) pat += 2 * pow3[i];
        else if (counts[gs]) pat += pow3[i];
      }
      for (i = 0; i < L; i++) counts[a[ao + i]] = 0;
      return pat;
    }
    var greenMask = 0;
    for (i = 0; i < L; i++) {
      if (g[go + i] === a[ao + i]) { pat += 2 * pow3[i]; greenMask |= (1 << i); }
      else counts[a[ao + i]]++;
    }
    for (i = 0; i < L; i++) {
      if (greenMask & (1 << i)) continue;
      gs = g[go + i];
      if (counts[gs] > 0) { pat += pow3[i]; counts[gs]--; }
    }
    for (i = 0; i < L; i++) counts[a[ao + i]] = 0;
    return pat;
  };

  Core.pow3 = function (L) { var p = []; for (var i = 0, v = 1; i < L; i++, v *= 3) p.push(v); return p; };

  // Score a pool of guesses against remaining answers.
  // U: flat Uint16Array universe, L, K (#symbols), rule, rem: Int32Array of universe idx (answers still possible),
  // pool: Int32Array of universe idx (guesses to score), isCand: Uint8Array over universe (1 = remaining answer)
  Core.scorePool = function (U, L, K, rule, rem, pool, isCand, onProgress) {
    var pow3 = Core.pow3(L), n = rem.length, allGreen = 0, i;
    for (i = 0; i < L; i++) allGreen += 2 * pow3[i];
    var counts = new Int16Array(K + 2);
    var space = Math.pow(3, L);
    var useArr = space <= 2000000;
    var bucket = useArr ? new Int32Array(space) : null;
    var touched = new Int32Array(n);
    var out = new Array(pool.length);
    for (var p = 0; p < pool.length; p++) {
      var gi = pool[p], go = gi * L, nt = 0, map = useArr ? null : new Map();
      for (var r = 0; r < n; r++) {
        var pat = Core.feedback(U, go, U, rem[r] * L, L, rule, counts, pow3);
        if (useArr) { if (bucket[pat]++ === 0) touched[nt++] = pat; }
        else { var c = map.get(pat); if (c === undefined) { map.set(pat, 1); touched[nt++] = pat; } else map.set(pat, c + 1); }
      }
      var sumSq = 0, worst = 0, ent = 0, solved = 0;
      for (var t = 0; t < nt; t++) {
        var pt = touched[t], cnt = useArr ? bucket[pt] : map.get(pt);
        if (useArr) bucket[pt] = 0;
        var pr = cnt / n;
        ent -= pr * Math.log2(pr);
        if (pt === allGreen) { solved = cnt; continue; }
        sumSq += cnt * cnt;
        if (cnt > worst) worst = cnt;
      }
      out[p] = { idx: gi, exp: n ? sumSq / n : 0, worst: worst, splits: nt, ent: ent, cand: isCand[gi] ? 1 : 0, solved: solved };
      if (onProgress && (p & 511) === 511) onProgress(p + 1, pool.length);
    }
    return out;
  };

  Core.sorters = {
    avg: function (a, b) { return a.exp - b.exp || b.cand - a.cand || a.worst - b.worst || b.ent - a.ent; },
    entropy: function (a, b) { return b.ent - a.ent || b.cand - a.cand || a.exp - b.exp; },
    minimax: function (a, b) { return a.worst - b.worst || a.exp - b.exp || b.cand - a.cand; },
    splits: function (a, b) { return b.splits - a.splits || b.cand - a.cand || a.exp - b.exp; }
  };

  Core.rank = function (scores, mode, topN) {
    scores.sort(Core.sorters[mode] || Core.sorters.avg);
    return scores.slice(0, topN);
  };

  root.SolverCore = Core;
})(typeof self !== 'undefined' ? self : this);
