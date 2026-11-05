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

  root.SolverCore = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof self !== 'undefined' ? self : this);
