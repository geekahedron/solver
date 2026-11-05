/* Wordle-style solver core — shared by the page (app.js) and the Web Worker (worker.js).
 * Words are encoded as flat Uint16Array of symbol ids (L symbols per word).
 * Feedback patterns are base-3 integers: digit i = 0 gray, 1 yellow, 2 green (position 0 = least significant).
 *
 * scorePool is one ply (expected remaining, entropy, worst, splits).
 * attachExpectedSteps adds the average number of guesses until the secret is
 * found, uniform over the remaining answers. See stepsLimits for where that
 * tree is exact and where it is cut down. */
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

  // Expected-steps search bounds. Tiny lists stay under these and are exact.
  // Larger lists (an English opening) deepen a beam, then play a greedy
  // continuation until the set is small enough to solve exactly.
  //   exactSet    — full search of the legal guess list at or below this size
  //   exactPool   — per-node guess list cut (answers first) above this
  //   shortlist   — probes kept from a large dictionary, chosen once for the root set
  //   rankAllMax  — score every pool guess only up to this many answers
  //   rankAllPool — and only when the scored pool is no bigger than this
  //   beamExp/Ent/Worst — one-ply leaders deepened on large sets
  //   contPool    — guesses considered at one greedy node
  //   nodeBeam    — one-ply leaders fully valued at one greedy node
  Core.stepsLimits = {
    exactSet: 5,
    exactPool: 64,
    shortlist: 280,
    rankAllMax: 40,
    rankAllPool: 20000,
    beamExp: 18,
    beamEnt: 6,
    beamWorst: 6,
    contPool: 40,
    nodeBeam: 1,
    maxDepth: 12
  };

  function stepsLimit(opts) {
    var base = Core.stepsLimits;
    var over = (opts && opts.limits) || {};
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k) && over[k] != null) out[k] = over[k];
    return out;
  }

  // Attach score.steps (and score.approx) for each ranked guess.
  // steps = 1 + the average, over remaining answers, of guesses still needed
  // after this one. All-green adds 0. Each remaining answer is equally likely.
  // opts: { guessMode, hard, clues: [{ids, pat, digits}], dict: indices, limits, onProgress }
  // dict is the guess list before hard-mode filters. answersOnly ignores it and
  // replays from the answers still possible. Continuations rebuild that pool
  // after each new clue, so hard mode and guess mode apply on later plies.
  Core.attachExpectedSteps = function (scores, U, L, K, rule, rem, pool, opts) {
    opts = opts || {};
    var limits = stepsLimit(opts);
    var guessMode = opts.guessMode || 'dictionary';
    var hard = opts.hard || 'off';
    var pow3 = Core.pow3(L);
    var counts = new Int16Array((K || 1) + 2);
    var allGreen = 0;
    var i;
    for (i = 0; i < L; i++) allGreen += 2 * pow3[i];
    if (!scores || !scores.length || !rem || !rem.length) return scores;

    var remArr = [];
    for (i = 0; i < rem.length; i++) remArr.push(rem[i]);
    remArr.sort(function (a, b) { return a - b; });

    var dict = opts.dict || pool;
    var clues0 = [];
    var rawClues = opts.clues || [];
    for (i = 0; i < rawClues.length; i++) clues0.push(normClue(rawClues[i]));

    var maxI = 0;
    function bump(arr) {
      if (!arr) return;
      for (var j = 0; j < arr.length; j++) if (arr[j] > maxI) maxI = arr[j];
    }
    bump(dict);
    bump(remArr);
    bump(pool);
    var inDict = new Uint8Array(maxI + 1);
    if (dict && guessMode !== 'answersOnly') {
      for (i = 0; i < dict.length; i++) inDict[dict[i]] = 1;
    }

    var cache = new Map();
    var legalCache = new Map();
    var lb = stepsLower(L, remArr.length);

    function normClue(c) {
      var digits = c.digits;
      var p;
      if (!digits) {
        digits = [];
        p = c.pat;
        for (var d = 0; d < L; d++) { digits.push(p % 3); p = (p / 3) | 0; }
      }
      return { ids: c.ids, pat: c.pat, digits: digits };
    }
    function hardOn() {
      return hard === 'wordle' || hard === 'strict' || guessMode === 'hard';
    }
    function constraintsActive(clues) {
      return hardOn() && clues && clues.length;
    }
    function clueKey(clues) {
      var parts = [];
      for (var c = 0; c < clues.length; c++) parts.push(clues[c].pat + ':' + clues[c].ids.join('.'));
      return parts.join('|');
    }
    function stateKey(set, clues) {
      var s = set.join(',');
      return constraintsActive(clues) ? s + '#' + clueKey(clues) : s;
    }
    function childClues(clues, gi, pat) {
      if (!hardOn()) return clues;
      var ids = [];
      var base = gi * L;
      var d;
      for (d = 0; d < L; d++) ids.push(U[base + d]);
      var digits = [];
      var p = pat;
      for (d = 0; d < L; d++) { digits.push(p % 3); p = (p / 3) | 0; }
      var next = clues.slice();
      next.push({ ids: ids, pat: pat, digits: digits });
      return next;
    }
    function wordleOk(idx, clues) {
      var base = idx * L;
      var c, i, cl, k, s, found, have, j;
      for (c = 0; c < clues.length; c++) {
        cl = clues[c];
        var needSym = [];
        var needN = [];
        for (i = 0; i < L; i++) {
          if (cl.digits[i] === 2 && U[base + i] !== cl.ids[i]) return false;
          if (cl.digits[i] > 0) {
            s = cl.ids[i];
            found = -1;
            for (k = 0; k < needSym.length; k++) if (needSym[k] === s) { found = k; break; }
            if (found < 0) { needSym.push(s); needN.push(1); }
            else needN[found]++;
          }
        }
        for (k = 0; k < needSym.length; k++) {
          have = 0;
          for (j = 0; j < L; j++) if (U[base + j] === needSym[k]) have++;
          if (have < needN[k]) return false;
        }
      }
      return true;
    }
    function consistent(idx, clues) {
      var ao = idx * L;
      for (var c = 0; c < clues.length; c++) {
        if (Core.feedback(clues[c].ids, 0, U, ao, L, rule, counts, pow3) !== clues[c].pat) return false;
      }
      return true;
    }
    function passes(idx, clues) {
      if (!constraintsActive(clues)) return true;
      if (hard === 'wordle' && !wordleOk(idx, clues)) return false;
      if ((hard === 'strict' || guessMode === 'hard') && !consistent(idx, clues)) return false;
      return true;
    }
    function isLegal(idx, clues) {
      if (guessMode === 'answersOnly') return passes(idx, clues);
      if (!inDict[idx]) return false;
      return passes(idx, clues);
    }
    function filterList(src, clues) {
      if (!constraintsActive(clues)) return src;
      var out = [];
      for (var j = 0; j < src.length; j++) if (passes(src[j], clues)) out.push(src[j]);
      return out;
    }
    var probeBase = dict;
    var stamp = new Int32Array(maxI + 1);
    var stampId = 1;
    function mergeAnswers(probes, set, clues) {
      if (stampId > 0x6fffffff) { stamp.fill(0); stampId = 1; }
      var id = ++stampId;
      var out = [];
      var i, g;
      for (i = 0; i < probes.length; i++) {
        g = probes[i];
        if (g > maxI || stamp[g] === id) continue;
        stamp[g] = id;
        out.push(g);
      }
      for (i = 0; i < set.length; i++) {
        g = set[i];
        if (g > maxI || stamp[g] === id) continue;
        if (guessMode !== 'answersOnly' && !inDict[g]) continue;
        if (!passes(g, clues)) continue;
        stamp[g] = id;
        out.push(g);
      }
      return out;
    }
    function legalCandidates(set, clues) {
      if (guessMode === 'answersOnly') return filterList(set, clues);
      var ck = constraintsActive(clues) ? clueKey(clues) : '';
      var hit = legalCache.get(ck);
      if (!hit) {
        hit = filterList(probeBase, clues);
        legalCache.set(ck, hit);
      }
      if (hit.length === dict.length && !constraintsActive(clues)) return hit;
      return mergeAnswers(hit, set, clues);
    }
    function inSet(idx, set) {
      var lo = 0, hi = set.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (set[mid] === idx) return true;
        if (set[mid] < idx) lo = mid + 1;
        else hi = mid - 1;
      }
      return false;
    }
    function prune(cands, set, max) {
      if (cands.length <= max) return cands;
      var pres = new Float64Array(Math.max(1, K));
      var pos = new Float64Array(Math.max(1, K) * L);
      var seen = new Int32Array(Math.max(1, K));
      var s, ri, base, sym, j;
      for (s = 0; s < seen.length; s++) seen[s] = -1;
      for (ri = 0; ri < set.length; ri++) {
        base = set[ri] * L;
        for (j = 0; j < L; j++) {
          sym = U[base + j];
          if (sym >= pres.length) continue;
          pos[sym * L + j]++;
          if (seen[sym] !== ri) { seen[sym] = ri; pres[sym]++; }
        }
      }
      var answers = [];
      var others = [];
      var n = set.length;
      for (var c = 0; c < cands.length; c++) {
        var gi = cands[c];
        var h = 0;
        var used = {};
        base = gi * L;
        for (j = 0; j < L; j++) {
          sym = U[base + j];
          if (sym < pres.length) {
            var pf = pos[sym * L + j];
            h += 0.5 * Math.min(pf, n - pf);
            if (!used[sym]) { used[sym] = 1; h += Math.min(pres[sym], n - pres[sym]); }
          }
        }
        (inSet(gi, set) ? answers : others).push({ gi: gi, h: h });
      }
      var byH = function (a, b) { return b.h - a.h; };
      answers.sort(byH);
      others.sort(byH);
      var ansBudget = Math.min(answers.length, Math.floor(max / 2));
      var othBudget = max - ansBudget;
      if (others.length < othBudget) {
        othBudget = others.length;
        ansBudget = Math.min(answers.length, max - othBudget);
      }
      var out = [];
      for (j = 0; j < ansBudget; j++) out.push(answers[j].gi);
      for (j = 0; j < othBudget; j++) out.push(others[j].gi);
      return out;
    }
    function partition(gi, set) {
      var n = set.length;
      var go = gi * L;
      var map = new Map();
      var buckets = [];
      for (var r = 0; r < n; r++) {
        var pat = Core.feedback(U, go, U, set[r] * L, L, rule, counts, pow3);
        var b = map.get(pat);
        if (!b) {
          b = { pat: pat, members: [] };
          map.set(pat, b);
          buckets.push(b);
        }
        b.members.push(set[r]);
      }
      var sumSq = 0;
      for (var t = 0; t < buckets.length; t++) {
        if (buckets[t].pat === allGreen) continue;
        var sz = buckets[t].members.length;
        sumSq += sz * sz;
      }
      var progress = !(buckets.length === 1 && buckets[0].pat !== allGreen);
      return { buckets: buckets, n: n, exp: n ? sumSq / n : 0, progress: progress };
    }
    function partitionLower(part) {
      var sum = 0;
      var buckets = part.buckets;
      for (var t = 0; t < buckets.length; t++) {
        if (buckets[t].pat === allGreen) continue;
        var sz = buckets[t].members.length;
        sum += sz * lb[sz];
      }
      return 1 + sum / part.n;
    }
    function solve2(set, clues) {
      if (set[0] > set[1]) set = [set[1], set[0]];
      var ck = stateKey(set, clues);
      var hit = cache.get(ck);
      if (hit) return hit;
      var out;
      if (isLegal(set[0], clues) || isLegal(set[1], clues)) out = { v: 1.5, approx: false };
      else {
        var cands = legalCandidates(set, clues);
        var split = false;
        var go, p0, p1, g;
        for (g = 0; g < cands.length; g++) {
          go = cands[g] * L;
          p0 = Core.feedback(U, go, U, set[0] * L, L, rule, counts, pow3);
          p1 = Core.feedback(U, go, U, set[1] * L, L, rule, counts, pow3);
          if (p0 !== p1) { split = true; break; }
        }
        out = { v: split ? 2 : Infinity, approx: false };
      }
      cache.set(ck, out);
      return out;
    }
    function solve3(set, clues) {
      if (set[0] > set[1] || set[1] > set[2]) set = set.slice().sort(function (a, b) { return a - b; });
      var ck = stateKey(set, clues);
      var hit = cache.get(ck);
      if (hit) return hit;
      var best = Infinity;
      var any = false;
      var i3, gi, o1, o2, p1, p2, e2, v;
      for (i3 = 0; i3 < 3; i3++) {
        gi = set[i3];
        if (!isLegal(gi, clues)) continue;
        any = true;
        o1 = set[(i3 + 1) % 3];
        o2 = set[(i3 + 2) % 3];
        p1 = Core.feedback(U, gi * L, U, o1 * L, L, rule, counts, pow3);
        p2 = Core.feedback(U, gi * L, U, o2 * L, L, rule, counts, pow3);
        if (p1 !== p2) v = 5 / 3;
        else {
          e2 = solve2(o1 < o2 ? [o1, o2] : [o2, o1], childClues(clues, gi, p1));
          v = (1 + 2 * (1 + e2.v)) / 3;
        }
        if (v < best) best = v;
      }
      // A non-answer that only isolates singletons scores 2. It can win only
      // when no legal answer scores 2 or better (hard mode took the answers away).
      if (!(any && best <= 2)) {
        var cands = legalCandidates(set, clues);
        for (var g = 0; g < cands.length; g++) {
          gi = cands[g];
          if (gi === set[0] || gi === set[1] || gi === set[2]) continue;
          var pats = [
            Core.feedback(U, gi * L, U, set[0] * L, L, rule, counts, pow3),
            Core.feedback(U, gi * L, U, set[1] * L, L, rule, counts, pow3),
            Core.feedback(U, gi * L, U, set[2] * L, L, rule, counts, pow3)
          ];
          var groups = new Map();
          for (var t = 0; t < 3; t++) {
            var arr = groups.get(pats[t]);
            if (!arr) groups.set(pats[t], arr = []);
            arr.push(set[t]);
          }
          if (groups.size === 1) continue;
          var extra = 0;
          groups.forEach(function (members, pat) {
            if (pat === allGreen) return;
            var sub = members.length === 1 ? 1 : solve2(members, childClues(clues, gi, pat)).v;
            extra += (members.length / 3) * sub;
          });
          v = 1 + extra;
          if (v < best) best = v;
        }
      }
      var out3 = { v: best, approx: false };
      cache.set(ck, out3);
      return out3;
    }
    function realize(part, clues, gi, depth) {
      var n = part.n;
      var buckets = part.buckets;
      var extra = 0;
      var approx = false;
      for (var t = 0; t < buckets.length; t++) {
        var b = buckets[t];
        if (b.pat === allGreen) continue;
        var sub = dispatch(b.members, childClues(clues, gi, b.pat), depth + 1);
        extra += (b.members.length / n) * sub.v;
        if (sub.approx) approx = true;
      }
      return { v: 1 + extra, approx: approx };
    }
    function solveExact(set, clues, depth) {
      var n = set.length;
      if (n <= 1) return { v: n === 1 ? 1 : 0, approx: false };
      if (n === 2) return solve2(set, clues);
      if (n === 3) return solve3(set, clues);
      var ck = stateKey(set, clues);
      var hit = cache.get(ck);
      if (hit) return hit;
      if (depth > limits.maxDepth) {
        var fused = { v: n, approx: true };
        cache.set(ck, fused);
        return fused;
      }
      var cands = legalCandidates(set, clues);
      var capped = false;
      if (cands.length > limits.exactPool) {
        cands = prune(cands, set, limits.exactPool);
        capped = true;
      }
      var ordered = [];
      var rest = [];
      for (var c = 0; c < cands.length; c++) {
        (inSet(cands[c], set) ? ordered : rest).push(cands[c]);
      }
      for (c = 0; c < rest.length; c++) ordered.push(rest[c]);
      var bestV = Infinity;
      var bestApprox = capped;
      for (c = 0; c < ordered.length; c++) {
        var part = partition(ordered[c], set);
        if (!part.progress) continue;
        if (partitionLower(part) >= bestV) continue;
        var ev = realize(part, clues, ordered[c], depth);
        if (ev.v < bestV) {
          bestV = ev.v;
          bestApprox = capped || ev.approx;
        }
      }
      var out = { v: bestV, approx: bestApprox };
      cache.set(ck, out);
      return out;
    }
    function solveGreedy(set, clues, depth) {
      var n = set.length;
      var ck = 'g|' + stateKey(set, clues);
      var hit = cache.get(ck);
      if (hit) return hit;
      if (depth > limits.maxDepth) {
        var fused = { v: n, approx: true };
        cache.set(ck, fused);
        return fused;
      }
      var cands = legalCandidates(set, clues);
      if (cands.length > limits.contPool) cands = prune(cands, set, limits.contPool);
      var ranked = [];
      for (var c = 0; c < cands.length; c++) {
        var part = partition(cands[c], set);
        if (!part.progress) continue;
        ranked.push({ gi: cands[c], part: part, exp: part.exp });
      }
      ranked.sort(function (a, b) { return a.exp - b.exp; });
      var best = { v: Infinity, approx: true };
      var take = Math.min(limits.nodeBeam, ranked.length);
      for (var k = 0; k < take; k++) {
        var ev = realize(ranked[k].part, clues, ranked[k].gi, depth);
        if (ev.v < best.v) best = { v: ev.v, approx: true };
      }
      cache.set(ck, best);
      return best;
    }
    function dispatch(set, clues, depth) {
      var n = set.length;
      if (n <= 1) return { v: n === 1 ? 1 : 0, approx: false };
      if (n <= 3 || n <= limits.exactSet) return solveExact(set, clues, depth);
      return solveGreedy(set, clues, depth);
    }
    function evalFirst(gi, set, clues) {
      if (set.length === 1) {
        if (gi === set[0]) return { v: 1, approx: false };
        return { v: isLegal(set[0], clues) ? 2 : Infinity, approx: false };
      }
      var part = partition(gi, set);
      if (!part.progress) {
        var cont = dispatch(set, clues, 1);
        return { v: 1 + cont.v, approx: cont.approx };
      }
      return realize(part, clues, gi, 0);
    }
    function selectBeam(list) {
      var chosen = new Set();
      var out = [];
      function take(sorted, k) {
        for (var j = 0; j < sorted.length && k > 0; j++) {
          if (chosen.has(sorted[j].idx)) continue;
          chosen.add(sorted[j].idx);
          out.push(sorted[j]);
          k--;
        }
      }
      take(list.slice().sort(function (a, b) { return a.exp - b.exp || b.ent - a.ent; }), limits.beamExp);
      take(list.slice().sort(function (a, b) { return b.ent - a.ent || a.exp - b.exp; }), limits.beamEnt);
      take(list.slice().sort(function (a, b) { return a.worst - b.worst || a.exp - b.exp; }), limits.beamWorst);
      return out;
    }

    if (guessMode !== 'answersOnly' && dict && dict.length > limits.shortlist) {
      probeBase = prune(dict, remArr, limits.shortlist);
    }
    var beamCap = limits.beamExp + limits.beamEnt + limits.beamWorst;
    var rankAll = remArr.length <= limits.rankAllMax && scores.length <= (limits.rankAllPool || 100000);
    var targets = (rankAll || scores.length <= beamCap) ? scores : selectBeam(scores);
    for (i = 0; i < scores.length; i++) { scores[i].steps = null; scores[i].approx = 0; }
    for (i = 0; i < targets.length; i++) {
      var ev = evalFirst(targets[i].idx, remArr, clues0);
      targets[i].steps = ev.v;
      targets[i].approx = ev.approx ? 1 : 0;
      if (opts.onProgress && ((i & 7) === 7 || i === targets.length - 1)) opts.onProgress(i + 1, targets.length);
    }
    return scores;
  };

  // Optimistic lower bound on expected guesses for a set of size n,
  // assuming any split into 3^L patterns is possible. Used only to skip
  // guesses that cannot beat the best one already found.
  function stepsLower(L, maxN) {
    var lb = new Float64Array(maxN + 1);
    var P = 1;
    var i, n;
    for (i = 0; i < L; i++) P *= 3;
    lb[0] = 0;
    if (maxN >= 1) lb[1] = 1;
    function splitBound(n, buckets, hit) {
      var items = hit ? n - 1 : n;
      if (items <= 0) return 1;
      var b = buckets < items ? buckets : items;
      if (b < 1) b = 1;
      var base = Math.floor(items / b);
      var extra = items % b;
      var sum = 0;
      var j, sz;
      for (j = 0; j < b; j++) {
        sz = base + (j < extra ? 1 : 0);
        sum += sz * lb[sz];
      }
      return 1 + sum / n;
    }
    for (n = 2; n <= maxN; n++) {
      var hit = splitBound(n, Math.max(1, P - 1), true);
      var miss = splitBound(n, Math.max(1, P), false);
      lb[n] = hit < miss ? hit : miss;
    }
    return lb;
  }

  Core.sorters = {
    avg: function (a, b) { return a.exp - b.exp || b.cand - a.cand || a.worst - b.worst || b.ent - a.ent; },
    entropy: function (a, b) { return b.ent - a.ent || b.cand - a.cand || a.exp - b.exp; },
    minimax: function (a, b) { return a.worst - b.worst || a.exp - b.exp || b.cand - a.cand; },
    splits: function (a, b) { return b.splits - a.splits || b.cand - a.cand || a.exp - b.exp; },
    steps: function (a, b) {
      var av = (a.steps == null || a.steps !== a.steps) ? Infinity : a.steps;
      var bv = (b.steps == null || b.steps !== b.steps) ? Infinity : b.steps;
      return av - bv || b.cand - a.cand || a.exp - b.exp || a.worst - b.worst;
    }
  };

  Core.rank = function (scores, mode, topN) {
    scores.sort(Core.sorters[mode] || Core.sorters.avg);
    return scores.slice(0, topN);
  };

  // Worst-case steps (guaranteed depth) from a position.
  //
  // maxSteps is the minimum, over legal first guesses, of the maximum over
  // remaining answers of how many further guesses a perfect line needs.
  // The guess being scored counts. Later plies use the same guess mode and
  // hard-mode rules as the suggestion pool (not a one-ply filter).
  //
  // This is not the one-ply "worst" bucket size. A guess can leave small
  // average buckets and still force a hard-mode dead end whose depth exceeds n.
  //
  // Exact while the answer list is small, or the legal guess list fits in the
  // beam. Otherwise a letter-coverage beam and a node cap apply. That pass is
  // fail-closed: guaranteed is set only when a concrete strategy of cost ≤ n
  // was proved. Missing a line refuses the guess; it never invents a proof.
  // "Guess a still-possible answer until it hits" is a real strategy, so
  // maxSteps ≤ |remaining| can be proved with an empty beam when every
  // remaining answer is legal to play.
  //
  // Returns evaluate(guessIdx) → {
  //   maxSteps, maxLower, maxExact, maxUncertain, maxExceeds, guaranteed, approx
  // }
  // maxSteps is a proved upper bound, or null when none was proved.
  // maxExact means that bound is optimal. A non-exact bound is still safe to
  // compare with n (the true depth is ≤ maxSteps).
  Core.prepareDepthSearch = function (spec) {
    var U = spec.U, L = spec.L, rule = spec.rule;
    var K = spec.K || 0;
    var pow3 = Core.pow3(L);
    var counts = new Int16Array((K || 8) + 2);
    var allGreen = 0, i;
    for (i = 0; i < L; i++) allGreen += 2 * pow3[i];
    var rem0 = [];
    for (i = 0; i < spec.rem.length; i++) rem0.push(spec.rem[i] | 0);
    rem0.sort(function (a, b) { return a - b; });
    var guessIdx = [];
    var inGuess = new Uint8Array(Math.max(1, (U.length / L) | 0));
    var src = spec.guessIdx || [];
    for (i = 0; i < src.length; i++) {
      var gi0 = src[i] | 0;
      if (!inGuess[gi0]) { inGuess[gi0] = 1; guessIdx.push(gi0); }
    }
    var hard = spec.hard || 'off';
    var guessMode = spec.guessMode || 'dictionary';
    var strict = guessMode === 'hard' || hard === 'strict';
    var budget = spec.budget | 0;
    var beam = spec.beam == null ? 24 : spec.beam | 0;
    var nodeCap = spec.nodeCap == null ? 20000 : spec.nodeCap | 0;
    var exactLimit = spec.exactLimit == null ? 16 : spec.exactLimit | 0;
    var timeCapMs = spec.timeCapMs == null ? 2000 : spec.timeCapMs;
    var beamOnly = !!spec.beamOnly;
    var baseClues = normalizeClues(spec.clues || []);
    var memo = new Map();
    var idsCache = new Array(inGuess.length);
    var ctx = { nodes: 0, capHit: false, approx: false, deadline: Infinity };

    function normalizeClues(list) {
      var out = [], c, p, d, j;
      for (c = 0; c < list.length; c++) {
        var cl = list[c];
        if (!cl || cl.pat == null || !cl.ids) continue;
        var ids = cl.ids instanceof Uint16Array ? cl.ids : Uint16Array.from(cl.ids);
        if (cl.digits && cl.digits.length === L) d = cl.digits;
        else {
          d = new Uint8Array(L);
          p = cl.pat | 0;
          for (j = 0; j < L; j++) { d[j] = p % 3; p = Math.floor(p / 3); }
        }
        out.push({ ids: ids, pat: cl.pat | 0, digits: d });
      }
      return out;
    }

    function idsOf(gi) {
      var ids = idsCache[gi];
      if (!ids) {
        ids = new Uint16Array(L);
        var o = gi * L, j;
        for (j = 0; j < L; j++) ids[j] = U[o + j];
        idsCache[gi] = ids;
      }
      return ids;
    }

    function makeClue(gi, pat) {
      var digits = new Uint8Array(L), p = pat, j;
      for (j = 0; j < L; j++) { digits[j] = p % 3; p = Math.floor(p / 3); }
      return { ids: idsOf(gi), pat: pat, digits: digits };
    }

    function consistent(gi, clues) {
      var ao = gi * L, c;
      for (c = 0; c < clues.length; c++) {
        if (Core.feedback(clues[c].ids, 0, U, ao, L, rule, counts, pow3) !== clues[c].pat) return false;
      }
      return true;
    }

    function wordleHard(gi, clues) {
      var base = gi * L, c, j, cl, s, have, need;
      for (c = 0; c < clues.length; c++) {
        cl = clues[c];
        need = new Map();
        for (j = 0; j < L; j++) {
          if (cl.digits[j] === 2 && U[base + j] !== cl.ids[j]) return false;
          if (cl.digits[j] > 0) need.set(cl.ids[j], (need.get(cl.ids[j]) || 0) + 1);
        }
        var ok = true;
        need.forEach(function (nNeed, sym) {
          have = 0;
          for (s = 0; s < L; s++) if (U[base + s] === sym) have++;
          if (have < nNeed) ok = false;
        });
        if (!ok) return false;
      }
      return true;
    }

    function playable(gi, clues, rem) {
      if (guessMode === 'answersOnly') {
        for (var r = 0; r < rem.length; r++) if (rem[r] === gi) return true;
        return false;
      }
      if (!inGuess[gi]) return false;
      if (strict) return consistent(gi, clues);
      if (hard === 'wordle') return wordleHard(gi, clues);
      return true;
    }

    function allRemPlayable(rem, clues) {
      for (var r = 0; r < rem.length; r++) if (!playable(rem[r], clues, rem)) return false;
      return true;
    }

    function legalList(clues, rem) {
      if (guessMode === 'answersOnly') return rem.slice();
      if (!strict && hard !== 'wordle') return guessIdx;
      var out = [], g;
      for (g = 0; g < guessIdx.length; g++) if (playable(guessIdx[g], clues, rem)) out.push(guessIdx[g]);
      return out;
    }

    function orderGuesses(legal, rem) {
      if (legal.length <= 1) return legal.slice();
      var pos = new Float64Array((K + 1) * L);
      var pres = new Float64Array(K + 1);
      var seen = new Int32Array(K + 1);
      var r, j, sym;
      for (sym = 0; sym < seen.length; sym++) seen[sym] = -1;
      for (r = 0; r < rem.length; r++) {
        var base = rem[r] * L;
        for (j = 0; j < L; j++) {
          sym = U[base + j];
          if (sym > K) continue;
          pos[sym * L + j]++;
          if (seen[sym] !== r) { seen[sym] = r; pres[sym]++; }
        }
      }
      var n = rem.length;
      var scored = new Array(legal.length);
      for (r = 0; r < legal.length; r++) {
        var gi = legal[r], h = 0, used = new Set();
        base = gi * L;
        for (j = 0; j < L; j++) {
          sym = U[base + j];
          if (sym > K) continue;
          var pf = pos[sym * L + j];
          h += Math.min(pf, n - pf);
          if (!used.has(sym)) { used.add(sym); h += Math.min(pres[sym], n - pres[sym]); }
        }
        scored[r] = { gi: gi, h: h };
      }
      scored.sort(function (a, b) { return b.h - a.h || a.gi - b.gi; });
      var ordered = new Array(scored.length);
      for (r = 0; r < scored.length; r++) ordered[r] = scored[r].gi;
      return ordered;
    }

    function partition(gi, rem) {
      var go = gi * L;
      var index = new Map();
      var pats = [], lists = [], r, pat, k;
      for (r = 0; r < rem.length; r++) {
        pat = Core.feedback(U, go, U, rem[r] * L, L, rule, counts, pow3);
        k = index.get(pat);
        if (k === undefined) { k = pats.length; index.set(pat, k); pats.push(pat); lists.push([]); }
        lists[k].push(rem[r]);
      }
      return { pats: pats, lists: lists };
    }

    function clueKey(clues) {
      var s = '', c, j;
      for (c = 0; c < clues.length; c++) {
        s += clues[c].pat + ':';
        for (j = 0; j < L; j++) s += clues[c].ids[j] + '.';
        s += '|';
      }
      return s;
    }

    function stateKey(rem, clues) {
      return rem.join(',') + '#' + clueKey(clues);
    }

    function exactResult(steps) {
      return { steps: steps, upper: steps, lower: steps, exact: true, exceeds: false, uncertain: false };
    }

    function fromMemo(hit, maxCap) {
      if (hit.steps <= maxCap) return exactResult(hit.steps);
      return { steps: null, upper: null, lower: hit.steps, exact: false, exceeds: true, uncertain: false };
    }

    // Minimax worst-case guesses for a position, capped at maxCap.
    // A returned upper ≤ maxCap is a strategy that was actually found
    // (including "play remaining answers one at a time").
    function worstCase(rem, clues, maxCap) {
      if (rem.length === 0) return exactResult(0);
      if (rem.length === 1) {
        if (playable(rem[0], clues, rem)) return exactResult(1);
        return { steps: null, upper: null, lower: Infinity, exact: true, exceeds: true, uncertain: false };
      }
      if (maxCap < 2) {
        return { steps: null, upper: null, lower: 2, exact: false, exceeds: true, uncertain: false };
      }
      var key = stateKey(rem, clues);
      var hit = memo.get(key);
      if (hit) return fromMemo(hit, maxCap);
      // Two playable answers are always solved in 2: guess one, then the other.
      if (rem.length === 2 && allRemPlayable(rem, clues)) {
        memo.set(key, { steps: 2 });
        return exactResult(2);
      }
      if (++ctx.nodes > nodeCap || Date.now() >= ctx.deadline) {
        ctx.capHit = true;
        ctx.approx = true;
        return { steps: null, upper: null, lower: 2, exact: false, exceeds: false, uncertain: true, cut: true };
      }

      var legal = legalList(clues, rem);
      var exhaustive = legal.length <= beam || (rem.length <= exactLimit && !beamOnly);
      if (!exhaustive) ctx.approx = true;
      var list = orderGuesses(legal, rem);
      if (!exhaustive) list = list.slice(0, Math.max(0, beam));

      var bestUpper = null;
      var sawUnknown = false;
      var sawLoose = false;
      var achievingExact = false;

      // Guessing a remaining answer, then repeating, finishes in ≤ |rem|
      // guesses whenever those answers stay legal. That is a real strategy,
      // not a heuristic, so it may prove a guarantee with an empty beam.
      if (rem.length <= maxCap && allRemPlayable(rem, clues)) bestUpper = rem.length;

      for (var t = 0; t < list.length; t++) {
        // Exact search keeps going until the lower bound (2) or the list ends.
        // A beamed search stops at the first proved line inside the cap so a
        // long list cannot turn into a full decision tree.
        if (bestUpper != null && bestUpper <= (exhaustive ? 2 : maxCap)) break;
        if (ctx.nodes > nodeCap || Date.now() >= ctx.deadline) { ctx.capHit = true; ctx.approx = true; sawUnknown = true; break; }
        var outcome = evalGuess(list[t], rem, clues, maxCap, bestUpper);
        if (outcome.kind === 'cost') {
          if (bestUpper == null || outcome.cost < bestUpper) {
            bestUpper = outcome.cost;
            achievingExact = outcome.exact;
          } else if (!outcome.exact) sawLoose = true;
        } else if (outcome.kind === 'unknown') sawUnknown = true;
        else if (!outcome.exact) sawLoose = true;
      }

      if (bestUpper != null && bestUpper <= maxCap) {
        // A proved cost of 2 matches the lower bound for |rem| ≥ 2.
        // Otherwise the value is optimal only when every legal guess was
        // resolved exactly and none beat this strategy.
        var exact = bestUpper === 2 ||
          (exhaustive && !sawUnknown && !sawLoose && (achievingExact || bestUpper === rem.length));
        var res = {
          steps: exact ? bestUpper : null,
          upper: bestUpper,
          lower: exact ? bestUpper : 2,
          exact: exact,
          exceeds: false,
          uncertain: false
        };
        if (exact) memo.set(key, { steps: bestUpper });
        return res;
      }

      // No strategy inside the cap. That is a proof only when the guess list
      // was complete and no branch was abandoned as "maybe".
      if (exhaustive && !sawUnknown && !sawLoose) {
        return { steps: null, upper: null, lower: maxCap + 1, exact: false, exceeds: true, uncertain: false };
      }
      return { steps: null, upper: null, lower: 2, exact: false, exceeds: false, uncertain: true };
    }

    function evalGuess(gi, rem, clues, maxCap, bestUpper) {
      var part = partition(gi, rem);
      var worst = 1;
      var exact = true;
      var b, pat, members, sub, add, atLeast;
      var nontrivial = 0;
      var only = null;
      for (b = 0; b < part.pats.length; b++) {
        if (part.pats[b] === allGreen) continue;
        nontrivial++;
        only = part.lists[b];
      }
      // A guess that leaves every answer in one bucket does not shrink the
      // set. Extra constraints can only remove later guesses, so this line
      // is strictly worse than playing from the current position.
      if (nontrivial === 1 && only.length === rem.length) {
        return { kind: 'not-better', exact: true };
      }
      for (b = 0; b < part.pats.length; b++) {
        pat = part.pats[b];
        if (pat === allGreen) continue;
        members = part.lists[b];
        sub = worstCase(members, clues.concat([makeClue(gi, pat)]), maxCap - 1);
        if (sub.exceeds) {
          atLeast = 1 + sub.lower;
          if (atLeast > maxCap || (bestUpper != null && atLeast >= bestUpper)) {
            return { kind: 'not-better', exact: true };
          }
          return { kind: 'unknown' };
        }
        if (sub.uncertain || sub.upper == null) return { kind: 'unknown' };
        add = 1 + sub.upper;
        if (!sub.exact) exact = false;
        if (add > worst) worst = add;
        if ((bestUpper != null && worst >= bestUpper) || worst > maxCap) {
          return { kind: 'not-better', exact: exact };
        }
      }
      if (worst > maxCap) return { kind: 'not-better', exact: exact };
      return { kind: 'cost', cost: worst, exact: exact };
    }

    function evaluate(gi) {
      ctx.nodes = 0;
      ctx.capHit = false;
      ctx.approx = false;
      ctx.deadline = timeCapMs < 0 ? Infinity : Date.now() + timeCapMs;
      var maxCap = rem0.length <= exactLimit ? (rem0.length + 1) : budget;
      if (maxCap < 1) maxCap = 1;
      if (!rem0.length) {
        return { maxSteps: 0, maxLower: 0, maxExact: true, maxUncertain: false, maxExceeds: false, guaranteed: budget >= 0, approx: false };
      }
      var part = partition(gi, rem0);
      var upper = 1;
      var lower = 1;
      var upperOk = true;
      var exact = true;
      var uncertain = false;
      var exceeds = false;
      var b, pat, members, sub, u, atLeast;
      var subCap = maxCap - 1;
      for (b = 0; b < part.pats.length; b++) {
        pat = part.pats[b];
        if (pat === allGreen) continue;
        members = part.lists[b];
        if (subCap < 1) {
          upperOk = false;
          exact = false;
          exceeds = true;
          if (members.length >= 1 && lower < 2) lower = 2;
          continue;
        }
        sub = worstCase(members, baseClues.concat([makeClue(gi, pat)]), subCap);
        if (sub.exact) {
          u = 1 + sub.steps;
          if (u > upper) upper = u;
          if (u > lower) lower = u;
        } else if (sub.upper != null) {
          u = 1 + sub.upper;
          if (u > upper) upper = u;
          atLeast = 1 + (sub.lower || 1);
          if (atLeast > lower) lower = atLeast;
          exact = false;
        } else if (sub.exceeds) {
          upperOk = false;
          exact = false;
          exceeds = true;
          atLeast = 1 + sub.lower;
          if (atLeast > lower) lower = atLeast;
        } else {
          upperOk = false;
          exact = false;
          uncertain = true;
          atLeast = 1 + (sub.lower || 1);
          if (atLeast > lower) lower = atLeast;
        }
      }
      if (!upperOk) {
        upper = null;
        exact = false;
      } else if (!exact && upper === lower) {
        // Loose pieces met in the middle: the bound is tight.
        exact = true;
      }
      if (uncertain) exact = false;
      if (upper != null && lower > upper) lower = upper;
      var provedUpper = upper;
      return {
        maxSteps: provedUpper,
        maxLower: lower,
        maxExact: !!(exact && provedUpper != null && !uncertain),
        maxUncertain: uncertain || (provedUpper == null && !exceeds),
        maxExceeds: exceeds && provedUpper == null,
        guaranteed: provedUpper != null && provedUpper <= budget,
        approx: ctx.approx || uncertain
      };
    }

    return { evaluate: evaluate, exactLimit: exactLimit };
  };

  // Rank one-ply scores, optionally annotating worst-case steps and keeping
  // only guesses with a proved finish inside spec.budget.
  // Auto-annotates small lists even when the guarantee filter is off so the
  // Max steps column can show a trap. Large lists skip that work unless the
  // filter is on, and then a time cap refuses anything still unproved.
  Core.finishScores = function (scores, spec, onProgress) {
    spec = spec || {};
    var topN = spec.topN || 15;
    var autoLimit = spec.autoDepthLimit == null ? 20 : spec.autoDepthLimit;
    var exactLimit = spec.exactLimit == null ? 16 : spec.exactLimit;
    var guarantee = !!spec.guarantee;
    var remN = spec.rem ? spec.rem.length : 0;
    if (spec.mode === 'steps' && !spec.stepsAttached) {
      Core.attachExpectedSteps(scores, spec.U, spec.L, spec.K, spec.rule, spec.rem, spec.pool, {
        guessMode: spec.guessMode,
        hard: spec.hard,
        dict: spec.dict || spec.guessIdx,
        clues: spec.clues || []
      });
    }
    var search = (guarantee || remN <= autoLimit) ? Core.prepareDepthSearch(spec) : null;
    var ranked = Core.rank(scores, spec.mode, guarantee ? scores.length : topN);
    var checkLimit = ranked.length;
    if (guarantee) {
      var cap = remN <= exactLimit ? (spec.checkLimit || 60) : (spec.checkLimitLarge || 20);
      checkLimit = Math.min(ranked.length, cap);
    }
    var top = [];
    var checked = 0, exceeded = 0, uncertain = 0, depthApprox = false;
    var limit = guarantee ? checkLimit : ranked.length;
    for (var i = 0; i < limit && (!guarantee || top.length < topN); i++) {
      var row = ranked[i];
      if (search) {
        var depth = search.evaluate(row.idx);
        // score.approx is the expected-steps cut (0/1). Do not replace it
        // with this search's fail-closed flag.
        var stepsApprox = row.approx;
        var cut = depth.approx;
        delete depth.approx;
        Object.assign(row, depth);
        row.approx = stepsApprox;
        row.maxApprox = cut ? 1 : 0;
        if (cut && !row.maxExact) depthApprox = true;
        checked++;
        if (onProgress && (checked & 3) === 0) onProgress(checked, limit);
      }
      if (!guarantee || row.guaranteed) top.push(row);
      else if ((row.maxExact && row.maxSteps > spec.budget) || (row.maxExceeds && row.maxLower > spec.budget)) exceeded++;
      else uncertain++;
    }
    return {
      top: top,
      depth: {
        on: guarantee,
        budget: spec.budget,
        checked: checked,
        kept: guarantee ? top.length : checked,
        exceeded: exceeded,
        uncertain: uncertain,
        approx: depthApprox,
        limited: guarantee && top.length < topN && checked < ranked.length,
        computed: !!search
      }
    };
  };

  root.SolverCore = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof self !== 'undefined' ? self : this);
