/* Opener solve tree.
 * Browser: attaches SolverCore.buildOpenerTree. Node: require('./tree.js') after core.
 *
 * One fixed starting guess, then a concrete policy for every later guess:
 *   worst — minimise the worst-case number of guesses
 *   steps — minimise the average number of guesses (uniform answers)
 * Guess mode and hard mode apply on every later ply, same as expected steps.
 *
 * Depths are how many guesses this strategy actually plays, including the opener.
 * A depth is proved only when that answer was played to the end. Cuts and
 * dead ends stay unproved and never count as a finish within n.
 * "Guaranteed" is fail-closed: every answer played out, none over n, and every
 * later guess chosen by a full search. A shortlist pick can still produce a
 * real strategy (strategyFits) without that stronger claim. provedImpossible
 * is only the exhaustive worst-case policy. On a long list, hard mode picks
 * later guesses from a letter-coverage shortlist so the tree can finish in
 * the browser; that tree is marked approximate.
 *
 * planOpenerScan orders the starters the Tree page tries until one strategyFits.
 *
 * Expected information for an opener is the entropy of the feedback-pattern
 * buckets from Analysis scorePool, using the pack's own marks:
 *   I(g) = -sum (n_i / N) * log2(n_i / N)
 * chooseOpenerList keeps an authored pack list in that order. With no authored
 * list it keeps the top OPENER_GENERATED_CAP candidates by that entropy.
 */
(function (root) {
  'use strict';

  var Core = root.SolverCore;
  if (!Core && typeof require === 'function') Core = require('./core.js');

  var DEFAULTS = {
    exactSet: 8,
    exactPool: 280,
    probePool: 48,
    nodeCap: 250000,
    timeCapMs: 12000,
    maxDepth: 14
  };

  function limitsOf(spec) {
    var over = (spec && spec.limits) || {};
    var out = {};
    var k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) out[k] = DEFAULTS[k];
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k) && over[k] != null) out[k] = over[k];
    return out;
  }

  function uniqSorted(src) {
    var a = [];
    var i;
    for (i = 0; i < src.length; i++) a.push(src[i] | 0);
    a.sort(function (x, y) { return x - y; });
    var o = [];
    for (i = 0; i < a.length; i++) if (!o.length || o[o.length - 1] !== a[i]) o.push(a[i]);
    return o;
  }

  Core.buildOpenerTree = function (spec, onProgress) {
    spec = spec || {};
    var U = spec.U;
    var L = spec.L | 0;
    var K = spec.K | 0;
    var rule = spec.rule || 'wordle';
    var limits = limitsOf(spec);
    var policy = spec.policy === 'steps' ? 'steps' : 'worst';
    var budget = spec.budget | 0;
    if (budget < 1) budget = 1;
    var hard = spec.hard || 'off';
    var guessMode = spec.guessMode || 'dictionary';
    var strict = guessMode === 'hard' || hard === 'strict';
    var marks = Core.bindMarks(L, K, rule, spec.hooks);
    var pow3 = marks.pow;
    var counts = new Int16Array((K || 1) + 2);
    var allGreen = marks.allGreen;
    var i;

    var rem = uniqSorted(spec.rem || []);
    var guessIdx = uniqSorted(spec.guessIdx || []);
    var nWords = Math.max(1, (U.length / L) | 0);
    var inGuess = new Uint8Array(nWords);
    for (i = 0; i < guessIdx.length; i++) if (guessIdx[i] >= 0 && guessIdx[i] < nWords) inGuess[guessIdx[i]] = 1;

    var baseClues = normalizeClues(spec.clues || []);
    var idsCache = new Array(nWords);
    var legalCache = new Map();
    var memo = new Map();
    var depths = [];
    var ctx = { nodes: 0, truncated: false, policyApprox: false, assigned: 0 };
    var deadline = limits.timeCapMs < 0 ? Infinity : Date.now() + limits.timeCapMs;
    var lastTick = 0;

    function tick(force) {
      if (!onProgress) return;
      var now = Date.now();
      if (!force && now - lastTick < 80) return;
      lastTick = now;
      onProgress(ctx.assigned, rem.length, ctx.nodes);
    }

    function normalizeClues(list) {
      var out = [];
      var c, cl, ids, digits, p, j;
      for (c = 0; c < list.length; c++) {
        cl = list[c];
        if (!cl || cl.pat == null || !cl.ids) continue;
        ids = cl.ids instanceof Uint16Array ? cl.ids : Uint16Array.from(cl.ids);
        if (cl.digits && cl.digits.length === L) digits = cl.digits;
        else {
          digits = new Array(L);
          p = cl.pat | 0;
          for (j = 0; j < L; j++) { digits[j] = p % marks.base; p = (p / marks.base) | 0; }
        }
        out.push({ ids: ids, pat: cl.pat | 0, digits: digits });
      }
      return out;
    }

    function idsOf(gi) {
      var ids = idsCache[gi];
      var o, j;
      if (!ids) {
        ids = new Uint16Array(L);
        o = gi * L;
        for (j = 0; j < L; j++) ids[j] = U[o + j];
        idsCache[gi] = ids;
      }
      return ids;
    }

    function clueKey(clues) {
      var parts = [];
      var c, j, ids, s;
      for (c = 0; c < clues.length; c++) {
        ids = clues[c].ids;
        s = clues[c].pat + ':';
        for (j = 0; j < L; j++) s += ids[j] + '.';
        parts.push(s);
      }
      return parts.join('|');
    }

    function constrained(clues) {
      return (hard === 'wordle' || strict) && clues && clues.length;
    }

    function stateKey(set, clues) {
      var s = set.join(',');
      return constrained(clues) ? s + '#' + clueKey(clues) : s;
    }

    function childClues(clues, ids, pat) {
      var digits, p, d, next;
      if (hard !== 'wordle' && !strict) return clues;
      digits = new Array(L);
      p = pat;
      for (d = 0; d < L; d++) { digits[d] = p % marks.base; p = (p / marks.base) | 0; }
      next = clues.slice();
      next.push({ ids: ids, pat: pat, digits: digits });
      return next;
    }

    function wordleOk(idx, clues) {
      var base = idx * L;
      var c, i, cl, k, s, found, have, j, needSym, needN;
      for (c = 0; c < clues.length; c++) {
        cl = clues[c];
        needSym = [];
        needN = [];
        for (i = 0; i < L; i++) {
          if (marks.isCorrect(cl.digits[i]) && U[base + i] !== cl.ids[i]) return false;
          if (marks.isRevealed(cl.digits[i])) {
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
      var c;
      for (c = 0; c < clues.length; c++) {
        if (marks.pat(clues[c].ids, 0, U, ao, L, rule, counts, pow3) !== clues[c].pat) return false;
      }
      return true;
    }

    function inSet(idx, set) {
      var lo = 0, hi = set.length - 1, mid;
      while (lo <= hi) {
        mid = (lo + hi) >> 1;
        if (set[mid] === idx) return true;
        if (set[mid] < idx) lo = mid + 1;
        else hi = mid - 1;
      }
      return false;
    }

    function playable(gi, clues, remNow) {
      if (gi < 0 || gi >= nWords) return false;
      if (guessMode === 'answersOnly') {
        if (!inSet(gi, remNow)) return false;
      } else if (!inGuess[gi]) return false;
      if (!constrained(clues)) return true;
      if (strict && !consistent(gi, clues)) return false;
      if (hard === 'wordle' && !wordleOk(gi, clues)) return false;
      return true;
    }

    function legalList(clues, remNow) {
      var out, g, ck, hit, list;
      if (guessMode === 'answersOnly') {
        if (!constrained(clues)) return remNow;
        out = [];
        for (g = 0; g < remNow.length; g++) if (playable(remNow[g], clues, remNow)) out.push(remNow[g]);
        return out;
      }
      if (!constrained(clues)) return guessIdx;
      ck = clueKey(clues);
      hit = legalCache.get(ck);
      if (hit) return hit;
      list = [];
      for (g = 0; g < guessIdx.length; g++) if (playable(guessIdx[g], clues, remNow)) list.push(guessIdx[g]);
      legalCache.set(ck, list);
      return list;
    }

    function prune(cands, set, max) {
      var pres = new Float64Array(Math.max(1, K));
      var pos = new Float64Array(Math.max(1, K) * L);
      var seen = new Int32Array(Math.max(1, K));
      var s, ri, base, sym, j, answers, others, n, c, gi, h, used, pf, byH, ansBudget, othBudget, out;
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
      answers = [];
      others = [];
      n = set.length;
      for (c = 0; c < cands.length; c++) {
        gi = cands[c];
        h = 0;
        used = {};
        base = gi * L;
        for (j = 0; j < L; j++) {
          sym = U[base + j];
          if (sym < pres.length) {
            pf = pos[sym * L + j];
            h += 0.5 * Math.min(pf, n - pf);
            if (!used[sym]) { used[sym] = 1; h += Math.min(pres[sym], n - pres[sym]); }
          }
        }
        (inSet(gi, set) ? answers : others).push({ gi: gi, h: h });
      }
      byH = function (a, b) { return b.h - a.h || a.gi - b.gi; };
      answers.sort(byH);
      others.sort(byH);
      ansBudget = Math.min(answers.length, Math.floor(max / 2));
      othBudget = max - ansBudget;
      if (others.length < othBudget) {
        othBudget = others.length;
        ansBudget = Math.min(answers.length, max - othBudget);
      }
      out = [];
      for (j = 0; j < ansBudget; j++) out.push(answers[j].gi);
      for (j = 0; j < othBudget; j++) out.push(others[j].gi);
      return out;
    }

    function mergeUnique(primary, extra) {
      var seen = new Set();
      var out = [];
      var i, g;
      for (i = 0; i < primary.length; i++) {
        g = primary[i];
        if (seen.has(g)) continue;
        seen.add(g);
        out.push(g);
      }
      for (i = 0; i < extra.length; i++) {
        g = extra[i];
        if (seen.has(g)) continue;
        seen.add(g);
        out.push(g);
      }
      return out;
    }

    function playableAnswers(set, clues) {
      var out = [];
      var i;
      for (i = 0; i < set.length; i++) if (playable(set[i], clues, set)) out.push(set[i]);
      return out;
    }

    function candidatePool(set, clues, cap) {
      var answers = playableAnswers(set, clues);
      var legal, widened, passed, i;
      // Tiny lists (the tests, and any pack that fits in the cap) stay exhaustive.
      // A large hard-mode list is not filtered in full at every node: that is a
      // fresh pass over the whole dictionary for every pattern. Coverage picks a
      // shortlist, hard mode filters that shortlist, and the choice is approximate.
      if (!constrained(clues) || guessIdx.length <= cap) {
        legal = legalList(clues, set);
        if (legal.length <= cap) return { list: mergeUnique(legal, answers), pruned: false };
        return { list: mergeUnique(prune(legal, set, cap), answers), pruned: true };
      }
      widened = prune(guessIdx, set, cap * 4);
      passed = [];
      for (i = 0; i < widened.length; i++) {
        if (!playable(widened[i], clues, set)) continue;
        passed.push(widened[i]);
        if (passed.length >= cap) break;
      }
      return { list: mergeUnique(passed, answers), pruned: true };
    }

    function partitionIds(ids, set) {
      var map = new Map();
      var buckets = [];
      var r, pat, b;
      for (r = 0; r < set.length; r++) {
        pat = marks.pat(ids, 0, U, set[r] * L, L, rule, counts, pow3);
        b = map.get(pat);
        if (!b) {
          b = { pat: pat, members: [] };
          map.set(pat, b);
          buckets.push(b);
        }
        b.members.push(set[r]);
      }
      return buckets;
    }

    function splitsSet(buckets) {
      if (!buckets.length) return false;
      if (buckets.length > 1) return true;
      return buckets[0].pat === allGreen;
    }

    function better(a, b, set) {
      var aIn, bIn;
      if (policy === 'steps') {
        if (a.sum !== b.sum) return a.sum < b.sum;
        if (a.worst !== b.worst) return a.worst < b.worst;
      } else {
        if (a.worst !== b.worst) return a.worst < b.worst;
        if (a.sum !== b.sum) return a.sum < b.sum;
      }
      aIn = inSet(a.gi, set) ? 1 : 0;
      bIn = inSet(b.gi, set) ? 1 : 0;
      if (aIn !== bIn) return aIn > bIn;
      return a.gi < b.gi;
    }

    function outOfBudget() {
      if (ctx.nodes >= limits.nodeCap || Date.now() >= deadline) {
        ctx.truncated = true;
        return true;
      }
      return false;
    }

    function isolates(gi, set, clues) {
      var ids, part, b, sub, next;
      if (!playable(gi, clues, set)) return false;
      ids = idsOf(gi);
      part = partitionIds(ids, set);
      if (part.length !== set.length) return false;
      for (b = 0; b < part.length; b++) {
        if (part[b].members.length !== 1) return false;
        if (part[b].pat === allGreen) continue;
        sub = part[b].members;
        next = childClues(clues, ids, part[b].pat);
        if (!playable(sub[0], next, sub)) return false;
      }
      return true;
    }

    function exactEval(set, clues) {
      var ck = stateKey(set, clues);
      var hit = memo.get(ck);
      var isolated, sumBest, rec, pool, list, exactPool, best, t, gi, part, outcome;
      if (hit) return hit;
      if (set.length === 1) {
        if (playable(set[0], clues, set)) rec = { worst: 1, sum: 1, gi: set[0], exact: true, stuck: false, cut: false };
        else rec = { worst: Infinity, sum: Infinity, gi: null, exact: true, stuck: true, cut: false };
        memo.set(ck, rec);
        return rec;
      }
      for (t = 0; t < set.length; t++) {
        if (isolates(set[t], set, clues)) { isolated = set[t]; break; }
      }
      if (isolated != null) {
        sumBest = 1 + 2 * (set.length - 1);
        rec = { worst: 2, sum: sumBest, gi: isolated, exact: true, stuck: false, cut: false };
        memo.set(ck, rec);
        return rec;
      }
      if (++ctx.nodes >= limits.nodeCap || Date.now() >= deadline) {
        ctx.truncated = true;
        return { cut: true };
      }
      tick(false);
      pool = candidatePool(set, clues, limits.exactPool);
      list = pool.list;
      exactPool = !pool.pruned;
      best = null;
      for (t = 0; t < list.length; t++) {
        if ((t & 23) === 23 && (ctx.nodes >= limits.nodeCap || Date.now() >= deadline)) {
          ctx.truncated = true;
          return { cut: true };
        }
        gi = list[t];
        part = partitionIds(idsOf(gi), set);
        if (!splitsSet(part)) continue;
        outcome = evalParts(part, clues, idsOf(gi), set.length, best);
        if (outcome.cut) return { cut: true };
        if (!outcome.ok) continue;
        rec = { worst: outcome.worst, sum: outcome.sum, gi: gi, exact: exactPool && outcome.exact, stuck: false, cut: false };
        if (!best || better(rec, best, set)) best = rec;
        if (best.worst === 2 && best.sum === 2 * set.length && best.exact) break;
      }
      if (!best) {
        rec = { worst: Infinity, sum: Infinity, gi: null, exact: exactPool, stuck: true, cut: false };
        memo.set(ck, rec);
        return rec;
      }
      if (!exactPool) best.exact = false;
      memo.set(ck, best);
      return best;
    }

    function evalParts(part, clues, ids, n, best) {
      var order = part.slice().sort(function (a, b) {
        return b.members.length - a.members.length || a.pat - b.pat;
      });
      var worst = 1;
      var sum = 0;
      var exact = true;
      var seen = 0;
      var b, bucket, sz, sub, addWorst, next;
      for (b = 0; b < order.length; b++) {
        bucket = order[b];
        sz = bucket.members.length;
        if (bucket.pat === allGreen) {
          sum += sz;
          seen += sz;
          if (policy === 'steps' && best && (sum > best.sum || (sum === best.sum && seen < n))) return { ok: false };
          continue;
        }
        next = childClues(clues, ids, bucket.pat);
        sub = exactEval(bucket.members, next);
        if (sub.cut) return { cut: true };
        if (sub.stuck || !isFinite(sub.worst)) return { ok: false };
        addWorst = 1 + sub.worst;
        if (addWorst > worst) worst = addWorst;
        sum += sz + sub.sum;
        seen += sz;
        if (!sub.exact) exact = false;
        if (policy === 'worst' && best && worst > best.worst) return { ok: false };
        if (policy === 'steps' && best && (sum > best.sum || (sum === best.sum && seen < n))) return { ok: false };
      }
      return { ok: true, worst: worst, sum: sum, exact: exact };
    }

    function roughPick(set, clues) {
      var pool, list, best, t, gi, part, b, sz, worstB, sumSq, cand;
      if (outOfBudget()) return { cut: true };
      pool = candidatePool(set, clues, limits.probePool);
      list = pool.list;
      best = null;
      for (t = 0; t < list.length; t++) {
        if ((t & 15) === 15 && outOfBudget()) return { cut: true };
        gi = list[t];
        part = partitionIds(idsOf(gi), set);
        if (!splitsSet(part)) continue;
        worstB = 0;
        sumSq = 0;
        for (b = 0; b < part.length; b++) {
          if (part[b].pat === allGreen) continue;
          sz = part[b].members.length;
          if (sz > worstB) worstB = sz;
          sumSq += sz * sz;
        }
        cand = { gi: gi, worst: worstB, sum: sumSq };
        if (!best || better(cand, best, set)) best = cand;
      }
      ctx.nodes++;
      if (!best) return { stuck: true };
      return { gi: best.gi, exact: false };
    }

    function blank(set, extra) {
      var node = {
        guess: null,
        forced: false,
        policyExact: true,
        wasted: false,
        cut: false,
        stuck: false,
        solved: false,
        answers: set,
        n: set.length,
        children: [],
        maxDepth: null,
        sum: 0,
        provedCount: 0,
        over: 0,
        unproved: 0,
        expected: null
      };
      var k;
      for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) node[k] = extra[k];
      return node;
    }

    function remember(idx, depth, path, reason) {
      var row = { idx: idx, depth: depth, proved: reason == null, pats: path.slice() };
      if (reason) row.reason = reason;
      depths.push(row);
      ctx.assigned++;
    }

    function finish(node) {
      node.expected = (node.unproved === 0 && node.n > 0 && node.provedCount === node.n) ? node.sum / node.n : null;
      return node;
    }

    function absorb(node, child) {
      if (child.maxDepth != null && (node.maxDepth == null || child.maxDepth > node.maxDepth)) node.maxDepth = child.maxDepth;
      node.sum += child.sum || 0;
      node.provedCount += child.provedCount || 0;
      node.over += child.over || 0;
      node.unproved += child.unproved || 0;
    }

    function cutNode(set, path) {
      var r;
      ctx.truncated = true;
      for (r = 0; r < set.length; r++) remember(set[r], null, path, 'cut');
      tick(false);
      return finish(blank(set, { cut: true, policyExact: false, unproved: set.length, answers: set.slice() }));
    }

    function stuckNode(set, path) {
      var r;
      for (r = 0; r < set.length; r++) remember(set[r], null, path, 'stuck');
      tick(false);
      return finish(blank(set, { stuck: true, unproved: set.length, answers: set.slice() }));
    }

    function leaf(set, path) {
      var depth, over;
      path.push(allGreen);
      depth = path.length;
      remember(set[0], depth, path, null);
      path.pop();
      over = depth > budget ? 1 : 0;
      tick(false);
      return finish(blank(set, {
        guess: set[0],
        solved: true,
        policyExact: true,
        answers: set.slice(),
        maxDepth: depth,
        sum: depth,
        provedCount: 1,
        over: over,
        unproved: 0
      }));
    }

    function expand(set, clues, path, forced) {
      var choice, ids, part, only, sub, node, buckets, b, bucket, child, depthNow, r, ans;
      if (outOfBudget()) return cutNode(set, path);
      if (!forced && set.length === 1) return leaf(set, path);
      if (path.length >= limits.maxDepth) return cutNode(set, path);

      if (forced) {
        choice = { gi: forced.gi, ids: forced.ids, exact: true, forced: true };
      } else if (set.length <= limits.exactSet && !(constrained(clues) && guessIdx.length > limits.exactPool)) {
        // Hard mode on a large dictionary makes every pattern its own state, so a
        // full search of the endgames does not finish in the browser. One-ply on
        // a shortlist still plays a concrete strategy; it is marked approximate.
        choice = exactEval(set, clues);
        if (choice.cut) return cutNode(set, path);
        if (choice.stuck || choice.gi == null) return stuckNode(set, path);
        choice.ids = idsOf(choice.gi);
        choice.forced = false;
      } else {
        choice = roughPick(set, clues);
        if (choice.cut) return cutNode(set, path);
        if (choice.stuck || choice.gi == null) return stuckNode(set, path);
        choice.ids = idsOf(choice.gi);
        choice.exact = false;
        choice.forced = false;
      }
      if (!choice.exact && !choice.forced) ctx.policyApprox = true;

      ids = choice.ids;
      part = partitionIds(ids, set);
      if (!splitsSet(part)) {
        only = part[0];
        path.push(only.pat);
        sub = expand(set, childClues(clues, ids, only.pat), path, null);
        path.pop();
        node = blank(set, {
          guess: choice.gi,
          forced: !!choice.forced,
          policyExact: !!choice.exact,
          wasted: true,
          answers: set.slice()
        });
        child = {
          pat: only.pat,
          n: set.length,
          answers: set.slice(),
          solved: false,
          wasted: true,
          node: sub,
          maxDepth: sub.maxDepth,
          sum: sub.sum,
          provedCount: sub.provedCount,
          over: sub.over,
          unproved: sub.unproved,
          expected: sub.expected
        };
        node.children.push(child);
        absorb(node, child);
        return finish(node);
      }

      node = blank(set, {
        guess: choice.gi,
        forced: !!choice.forced,
        policyExact: !!choice.exact,
        answers: set.slice()
      });
      buckets = part.slice().sort(function (a, b) {
        return b.members.length - a.members.length || a.pat - b.pat;
      });
      for (b = 0; b < buckets.length; b++) {
        bucket = buckets[b];
        if (outOfBudget()) {
          path.push(bucket.pat);
          sub = cutNode(bucket.members, path);
          path.pop();
          child = {
            pat: bucket.pat,
            n: bucket.members.length,
            answers: bucket.members.slice(),
            solved: false,
            node: sub,
            maxDepth: sub.maxDepth,
            sum: sub.sum,
            provedCount: sub.provedCount,
            over: sub.over,
            unproved: sub.unproved,
            expected: sub.expected
          };
        } else if (bucket.pat === allGreen) {
          depthNow = path.length + 1;
          path.push(allGreen);
          ans = bucket.members;
          child = {
            pat: allGreen,
            n: ans.length,
            answers: ans.slice(),
            solved: true,
            node: null,
            maxDepth: depthNow,
            sum: depthNow * ans.length,
            provedCount: ans.length,
            over: depthNow > budget ? ans.length : 0,
            unproved: 0,
            expected: depthNow
          };
          for (r = 0; r < ans.length; r++) remember(ans[r], depthNow, path, null);
          path.pop();
          tick(false);
        } else {
          path.push(bucket.pat);
          sub = expand(bucket.members, childClues(clues, ids, bucket.pat), path, null);
          path.pop();
          child = {
            pat: bucket.pat,
            n: bucket.members.length,
            answers: bucket.members.slice(),
            solved: false,
            node: sub,
            maxDepth: sub.maxDepth,
            sum: sub.sum,
            provedCount: sub.provedCount,
            over: sub.over,
            unproved: sub.unproved,
            expected: sub.expected
          };
        }
        node.children.push(child);
        absorb(node, child);
      }
      node.children.sort(function (a, b) {
        var am = a.maxDepth == null ? -1 : a.maxDepth;
        var bm = b.maxDepth == null ? -1 : b.maxDepth;
        return (b.over - a.over) || (bm - am) || (b.n - a.n) || (a.pat - b.pat);
      });
      return finish(node);
    }

    var openerGi = spec.opener == null ? -1 : (spec.opener | 0);
    var openerIds;
    if (openerGi >= 0) openerIds = idsOf(openerGi);
    else {
      openerIds = new Uint16Array(L);
      var rawIds = spec.openerIds || [];
      for (i = 0; i < L; i++) openerIds[i] = rawIds[i] | 0;
    }

    var rootNode = null;
    if (rem.length) {
      rootNode = expand(rem, baseClues, [], { gi: openerGi, ids: openerIds });
    }
    tick(true);

    var proved = 0;
    var unproved = 0;
    var over = 0;
    var stuckN = 0;
    var sum = 0;
    var maxDepth = null;
    var d;
    for (d = 0; d < depths.length; d++) {
      if (!depths[d].proved) {
        unproved++;
        if (depths[d].reason === 'stuck') stuckN++;
      } else {
        proved++;
        sum += depths[d].depth;
        if (depths[d].depth > budget) over++;
        if (maxDepth == null || depths[d].depth > maxDepth) maxDepth = depths[d].depth;
      }
    }
    depths.sort(function (a, b) {
      if (a.proved !== b.proved) return a.proved ? 1 : -1;
      var da = a.depth == null ? 9999 : a.depth;
      var db = b.depth == null ? 9999 : b.depth;
      return db - da || a.idx - b.idx;
    });

    var playedOut = rem.length > 0 && unproved === 0 && proved === rem.length;
    var openerBreaksHard = false;
    if (openerGi >= 0 && baseClues.length) {
      if (hard === 'wordle' && !wordleOk(openerGi, baseClues)) openerBreaksHard = true;
      if (strict && !consistent(openerGi, baseClues)) openerBreaksHard = true;
    }
    var openerOutside = openerGi < 0 || !playable(openerGi, baseClues, rem);

    var summary = {
      answers: rem.length,
      expected: playedOut ? sum / rem.length : null,
      sum: playedOut ? sum : null,
      maxDepth: maxDepth,
      overBudget: over,
      unproved: unproved,
      stuck: stuckN,
      playedOut: playedOut,
      strategyFits: playedOut && maxDepth != null && maxDepth <= budget,
      guaranteed: playedOut && !ctx.policyApprox && !ctx.truncated && maxDepth != null && maxDepth <= budget,
      provedImpossible: policy === 'worst' && playedOut && !ctx.policyApprox && !ctx.truncated && maxDepth != null && maxDepth > budget,
      policyApprox: ctx.policyApprox,
      truncated: ctx.truncated,
      policy: policy,
      budget: budget,
      opener: openerGi,
      openerBreaksHard: openerBreaksHard,
      openerOutsidePool: openerOutside,
      exactSet: limits.exactSet,
      exactPool: limits.exactPool,
      probePool: limits.probePool,
      nodes: ctx.nodes
    };

    return { summary: summary, depths: depths, root: rootNode, allGreen: allGreen };
  };

  // How many starters to invent when a pack does not author an opener list.
  // Matches the English Wordle quick-pick count.
  Core.OPENER_GENERATED_CAP = 10;

  // |candidates| × |answers| past this keeps a prefix of the candidate list.
  // 397 Dungleon solutions scored against themselves sit under it. A generated
  // theoretical pool scored against itself does not, and is cut instead of
  // hanging the page.
  Core.OPENER_SCORE_CELLS = 1500000;

  // I(g) in bits: entropy of the feedback-pattern buckets when g is scored
  // against rem. Reuses Analysis scorePool (score.ent), including the pack
  // feedback in spec.hooks. All-green is one of the buckets. Best first.
  Core.rankByInformation = function (spec) {
    spec = spec || {};
    var U = spec.U;
    var L = spec.L | 0;
    var rem = spec.rem;
    var pool = spec.pool;
    if (!U || L < 1 || !rem || !rem.length || !pool || !pool.length) return [];
    var nWords = Math.max(1, (U.length / L) | 0);
    var isCand = new Uint8Array(nWords);
    var i, ri;
    for (i = 0; i < rem.length; i++) {
      ri = rem[i] | 0;
      if (ri >= 0 && ri < nWords) isCand[ri] = 1;
    }
    var scores = Core.scorePool(U, L, spec.K | 0, spec.rule || 'wordle', rem, pool, isCand, null, spec.hooks);
    scores.sort(Core.sorters.entropy);
    return scores;
  };

  // Keep a prefix of candidates when scoring every one against every answer
  // would exceed maxCells. Candidates are already in keep-first order.
  // answerCount < 1 returns the list unchanged (there is nothing to score).
  Core.boundOpenerCandidates = function (candidates, answerCount, maxCells) {
    var list = [];
    var i;
    candidates = candidates || [];
    for (i = 0; i < candidates.length; i++) list.push(candidates[i]);
    var n = answerCount | 0;
    if (n < 1) return list;
    var cells = maxCells == null ? Core.OPENER_SCORE_CELLS : maxCells;
    var cap = Math.floor(cells / n);
    if (cap < 1) cap = 1;
    if (list.length <= cap) return list;
    return list.slice(0, cap);
  };

  // Authored pack openers stay in authored order. Otherwise take the top
  // `limit` scores by expected information (bits, then still-possible, then
  // lower expected remaining, then the candidate index the caller stored).
  // spec.declared is true when the pack named an opener list, even if every
  // word was filtered out of this variant. That does not fall through to
  // generation. spec.scores is [{ word, bits, cand, exp, i }].
  Core.chooseOpenerList = function (spec) {
    spec = spec || {};
    var limit = spec.limit == null ? Core.OPENER_GENERATED_CAP : spec.limit | 0;
    if (limit < 0) limit = 0;
    if (spec.declared) {
      return { words: (spec.authored || []).slice(), source: 'pack', capped: false };
    }
    var ranked = (spec.scores || []).map(function (s, n) {
      return {
        word: s.word,
        bits: s.bits || 0,
        cand: s.cand || 0,
        exp: s.exp || 0,
        i: s.i == null ? n : s.i
      };
    });
    ranked.sort(function (a, b) {
      return (b.bits - a.bits) || (b.cand - a.cand) || (a.exp - b.exp) || (a.i - b.i);
    });
    var words = [];
    var seen = {};
    var i;
    for (i = 0; i < ranked.length && words.length < limit; i++) {
      if (!ranked[i].word || seen[ranked[i].word]) continue;
      seen[ranked[i].word] = 1;
      words.push(ranked[i].word);
    }
    return { words: words, source: 'generated', capped: !!spec.capped };
  };

  // Order for "try starters until one fits n".
  // picks: spec.openers that pass spec.has, original order, duplicates skipped.
  // The caller passes the pack's opener list, or the generated list when the
  // pack did not author one. When the remaining list is non-empty and no longer
  // than extraMaxRemaining, extras continue with spec.remaining, then spec.dict,
  // skipping anything already queued, up to extraCap further words. The caller
  // decides what dict means (probes before answers already ruled out, for the
  // Tree page).
  Core.planOpenerScan = function (spec) {
    spec = spec || {};
    var openers = spec.openers || [];
    var has = spec.has || function () { return false; };
    var remaining = spec.remaining || [];
    var dict = spec.dict || [];
    var extraMaxRemaining = spec.extraMaxRemaining == null ? 16 : spec.extraMaxRemaining;
    var extraCap = spec.extraCap == null ? 40 : spec.extraCap;
    var seen = {};
    var picks = [];
    var extra = [];
    var i, w;
    function take(word, into) {
      if (!word || seen[word] || !has(word)) return false;
      if (into === extra && extra.length >= extraCap) return false;
      seen[word] = 1;
      into.push(word);
      return true;
    }
    for (i = 0; i < openers.length; i++) take(openers[i], picks);
    var continued = remaining.length > 0 && remaining.length <= extraMaxRemaining;
    if (continued) {
      for (i = 0; i < remaining.length; i++) take(remaining[i], extra);
      for (i = 0; i < dict.length && extra.length < extraCap; i++) take(dict[i], extra);
    }
    return {
      picks: picks,
      extra: extra,
      all: picks.concat(extra),
      continued: continued,
      extraCap: extraCap,
      extraMaxRemaining: extraMaxRemaining
    };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof self !== 'undefined' ? self : this);
