/* Gauntlet: several puzzles from one pack, played back to back.
 * Browser: window.SolverGauntlet. Node: module.exports.
 *
 * One entity (one token, any slot) has to appear in every floor's solution.
 * Floor 1 is filtered only by its own clues. Later floors are filtered from
 * the solutions already known. Known and theoretical lists are filtered
 * separately, because an unsolved floor's remaining candidates can differ.
 *
 * A floor's solution, in order, is:
 *   1. the solution string the user typed, when it is a full word
 *   2. the latest all-correct guess on that floor (clueSolution)
 *   3. the single answer left on the active solution layer
 *
 * The active layer is known, theoretical, or preferred (known while any
 * known answer remains, otherwise theoretical). A unique answer on the
 * other layer does not count until the user types it or switches layer.
 *
 * Floor 2 keeps candidates that intersect floor 1's solution. Floor 3 (and
 * any later floor) keeps candidates that intersect the entities shared by
 * every earlier solved floor. With three floors that is the intersection of
 * floor 1 and floor 2.
 *
 * Partial knowledge, before every earlier floor is solved:
 * Floor 1 has to be known first. Later floors stay unfiltered until then,
 * even if a later solution was typed. Once floor 1 is known, each unsolved
 * earlier floor contributes the entities that still occur in at least one
 * of its remaining candidates on that same layer (after that floor's own
 * clues and after the shared-entity filter already applied to it). The
 * allowed set is the running intersection of those contributions. A
 * candidate is removed only when no remaining earlier candidate could still
 * make the rule true. Solving the missing floor replaces the bound with the
 * exact shared entities, and every floor below is meant to be recomputed
 * by calling propagate again.
 *
 * For the usual three floors, floor 2's filter is "intersects floor 1".
 * Intersecting floor 1 with the entities of floor 2's pre-filter list gives
 * the same bound as intersecting with the post-filter list, because a
 * candidate that failed the filter shares nothing with floor 1. The code
 * still uses the filtered list so a later floor sees only candidates that
 * are still possible.
 *
 * An empty allowed set means the rule cannot be met, so that layer's list
 * is empty. Editing or clearing a solution is just propagate with the new
 * inputs; earlier floors are never filtered by later ones.
 *
 * Openers use the same expected-information ranking as Scan openers
 * (Core.rankByInformation / Core.chooseOpenerList). An authored opener list
 * stays in authored order. Otherwise the top 10 guesses are ranked against
 * that floor's filtered active-layer answers. The guess candidates are the
 * pack guess list, then those answers, capped the same way Scan caps them.
 */
(function (root) {
  'use strict';

  var Gauntlet = {};
  Gauntlet.DEFAULT_FLOORS = 3;

  function entitiesOf(tokens) {
    var out = [];
    var seen = Object.create(null);
    var i, t;
    if (!tokens) return out;
    for (i = 0; i < tokens.length; i++) {
      t = tokens[i];
      if (t == null || t === '') continue;
      if (seen[t]) continue;
      seen[t] = 1;
      out.push(t);
    }
    return out;
  }

  Gauntlet.entities = entitiesOf;

  function asSet(list) {
    var set = Object.create(null);
    var i;
    if (!list) return set;
    for (i = 0; i < list.length; i++) if (list[i] != null && list[i] !== '') set[list[i]] = 1;
    return set;
  }

  function orderEntities(set, order) {
    var out = [];
    var seen = Object.create(null);
    var i, k;
    if (order) {
      for (i = 0; i < order.length; i++) {
        k = order[i];
        if (set[k] && !seen[k]) {
          seen[k] = 1;
          out.push(k);
        }
      }
    }
    Object.keys(set).forEach(function (key) {
      if (!seen[key]) out.push(key);
    });
    return out;
  }

  function hits(tokens, must) {
    var i;
    if (!tokens || !must) return false;
    for (i = 0; i < tokens.length; i++) if (must[tokens[i]]) return true;
    return false;
  }

  function filterIndices(idxs, must, tokensOf) {
    if (!must) return idxs ? idxs.slice() : [];
    var out = [];
    var i, idx, tokens;
    idxs = idxs || [];
    for (i = 0; i < idxs.length; i++) {
      idx = idxs[i];
      tokens = tokensOf(idx) || [];
      if (hits(tokens, must)) out.push(idx);
    }
    return out;
  }

  function unionSet(idxs, tokensOf) {
    var set = Object.create(null);
    var i, tokens, j;
    idxs = idxs || [];
    for (i = 0; i < idxs.length; i++) {
      tokens = tokensOf(idxs[i]) || [];
      for (j = 0; j < tokens.length; j++) if (tokens[j] != null && tokens[j] !== '') set[tokens[j]] = 1;
    }
    return set;
  }

  function intersectSet(current, listOrSet, isSet) {
    var next = Object.create(null);
    var k;
    if (!isSet) {
      listOrSet = asSet(listOrSet);
      isSet = true;
    }
    if (!current) {
      for (k in listOrSet) if (listOrSet[k]) next[k] = 1;
      return next;
    }
    for (k in listOrSet) if (listOrSet[k] && current[k]) next[k] = 1;
    return next;
  }

  function activeIndices(layer, known, theoretical) {
    if (layer === 'theoretical') return theoretical || [];
    if (layer === 'preferred') return (known && known.length) ? known : (theoretical || []);
    return known || [];
  }

  function listsEqual(a, b) {
    var i;
    if (!a || !b || a.length !== b.length) return false;
    for (i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Latest all-correct guess. correctValues are the clue digits whose role
  // is correct (Dungleon: g and G). Every slot correct means the guess is
  // the secret, whether or not that word is still in a list.
  Gauntlet.solvedClue = function (clues, correctValues) {
    var correct = Object.create(null);
    var i, c, d, ok;
    correctValues = correctValues || [2];
    for (i = 0; i < correctValues.length; i++) correct[correctValues[i]] = 1;
    if (!clues) return null;
    for (i = clues.length - 1; i >= 0; i--) {
      c = clues[i];
      if (!c || !c.digits || !c.digits.length || !c.key) continue;
      ok = true;
      for (d = 0; d < c.digits.length; d++) if (!correct[c.digits[d]]) { ok = false; break; }
      if (ok) return c.key;
    }
    return null;
  };

  function solutionTokens(key, spec) {
    var tokens;
    if (!key) return null;
    tokens = spec.tokensOfKey ? spec.tokensOfKey(key) : null;
    if (!tokens || !tokens.length) return null;
    if (spec.length && tokens.length !== spec.length) return null;
    return entitiesOf(tokens);
  }

  function layerStatus(apply, must, partial, waiting, none) {
    if (none) return 'none';
    if (waiting || !apply) return 'waiting';
    if (!must || !must.length) return 'impossible';
    return partial ? 'partial' : 'ready';
  }

  // spec.floors[i] = { known: idx[], theoretical: idx[], solution: key|null, clueSolution: key|null }
  // Indices are already filtered by that floor's clues.
  // spec.tokensOf(idx) -> token[]
  // spec.tokensOfKey(key) -> token[]
  // spec.keyOf(idx) -> string
  // spec.layer, spec.order (alphabet tokens), spec.length
  Gauntlet.propagate = function (spec) {
    spec = spec || {};
    var floors = spec.floors || [];
    var tokensOf = spec.tokensOf || function () { return []; };
    var keyOf = spec.keyOf || function () { return ''; };
    var layer = spec.layer || 'known';
    var order = spec.order || null;
    var prior = [];
    var out = [];
    var i;

    for (i = 0; i < floors.length; i++) {
      var raw = floors[i] || {};
      var knownIn = raw.known || [];
      var theoIn = raw.theoretical || [];
      var none = i === 0;
      // Later floors stay open until floor 1 itself has a solution.
      var waiting = !none && (!prior[0] || !prior[0].solutionTokens);
      var partial = false;
      var j, knownMustSet, theoMustSet, knownMust, theoMust;
      var knownOut, theoOut, active, pinned, fromClue, unique, solution, source, tokens;

      if (!none && !waiting) {
        for (j = 0; j < i; j++) if (!prior[j].solutionTokens) partial = true;
      }

      // null must means "do not filter". An empty set means nothing qualifies.
      function mustFor(idxsOf) {
        var set = null;
        var j2, entry2;
        if (none || waiting) return null;
        for (j2 = 0; j2 < i; j2++) {
          entry2 = prior[j2];
          if (entry2.solutionTokens) set = intersectSet(set, entry2.solutionTokens, false);
          else set = intersectSet(set, unionSet(idxsOf(entry2), tokensOf), true);
        }
        return set || Object.create(null);
      }

      knownMustSet = mustFor(function (entry) { return entry.known; });
      theoMustSet = mustFor(function (entry) { return entry.theoretical; });
      knownMust = knownMustSet ? orderEntities(knownMustSet, order) : [];
      theoMust = theoMustSet ? orderEntities(theoMustSet, order) : [];

      knownOut = filterIndices(knownIn, knownMustSet, tokensOf);
      theoOut = filterIndices(theoIn, theoMustSet, tokensOf);
      active = activeIndices(layer, knownOut, theoOut);

      pinned = solutionTokens(raw.solution, spec);
      fromClue = pinned ? null : solutionTokens(raw.clueSolution, spec);
      unique = null;
      if (!pinned && !fromClue && active.length === 1) unique = keyOf(active[0]);
      if (pinned) { solution = raw.solution; source = 'entered'; tokens = pinned; }
      else if (fromClue) { solution = raw.clueSolution; source = 'clue'; tokens = fromClue; }
      else if (unique) { solution = unique; source = 'unique'; tokens = solutionTokens(unique, spec); }
      else { solution = null; source = null; tokens = null; }

      prior.push({
        solutionTokens: tokens,
        known: knownOut,
        theoretical: theoOut
      });

      var activeMust = (layer === 'theoretical') ? theoMust
        : (layer === 'preferred' && !(knownOut && knownOut.length) ? theoMust : knownMust);
      var activeStatus = layerStatus(!none && !waiting, activeMust, partial, waiting, none);

      out.push({
        known: knownOut,
        theoretical: theoOut,
        active: active.slice(),
        solution: solution,
        solutionSource: source,
        constraint: {
          status: activeStatus,
          partial: !none && !waiting && partial,
          must: activeMust,
          knownMust: knownMust,
          theoreticalMust: theoMust,
          knownStatus: layerStatus(!none && !waiting, knownMust, partial, waiting, none),
          theoreticalStatus: layerStatus(!none && !waiting, theoMust, partial, waiting, none),
          layersDiffer: !listsEqual(knownMust, theoMust)
        }
      });
    }

    return { floors: out };
  };

  // Rank starters against one floor's remaining answers.
  // Mirrors Scan openers: authored lists keep their order; otherwise the
  // top `limit` (default 10) by expected information, in bits.
  Gauntlet.rankOpeners = function (Core, spec) {
    spec = spec || {};
    var rem = spec.rem || [];
    var declared = !!spec.declared;
    var authored = spec.authored || [];
    var limit = spec.limit == null ? (Core.OPENER_GENERATED_CAP || 10) : spec.limit;
    var keys = spec.keys;
    var lookup = spec.lookup || function () { return -1; };
    function keyAt(idx) {
      if (typeof keys === 'function') return keys(idx);
      return keys ? keys[idx] : '';
    }
    if (!rem.length) {
      return {
        words: declared ? authored.slice() : [],
        bits: {},
        capped: false,
        source: declared ? 'pack' : 'generated'
      };
    }

    var pool = [];
    var orderOf = Object.create(null);
    var capped = false;
    var seen = Object.create(null);
    function add(idx) {
      idx = idx | 0;
      if (idx < 0 || seen[idx]) return;
      seen[idx] = 1;
      pool.push(idx);
    }
    if (declared) {
      var a;
      for (a = 0; a < authored.length; a++) {
        var found = lookup(authored[a]);
        if (found == null || found < 0) continue;
        add(found);
        if (orderOf[found] == null) orderOf[found] = a;
      }
    } else {
      var g = spec.guessIdx || [];
      var e, extra = spec.extraIdx || [];
      for (e = 0; e < g.length; e++) add(g[e]);
      for (e = 0; e < extra.length; e++) add(extra[e]);
      for (e = 0; e < rem.length; e++) add(rem[e]);
      var bounded = Core.boundOpenerCandidates(pool, rem.length, spec.maxCells == null ? Core.OPENER_SCORE_CELLS : spec.maxCells);
      capped = bounded.length < pool.length;
      pool = bounded;
      for (e = 0; e < pool.length; e++) orderOf[pool[e]] = e;
    }

    var ranked = pool.length ? Core.rankByInformation({
      U: spec.U,
      L: spec.L,
      K: spec.K,
      rule: spec.rule || 'wordle',
      rem: rem instanceof Int32Array ? rem : Int32Array.from(rem),
      pool: Int32Array.from(pool),
      hooks: spec.hooks || null
    }) : [];
    var records = [];
    var bits = Object.create(null);
    var r, word;
    for (r = 0; r < ranked.length; r++) {
      word = keyAt(ranked[r].idx);
      bits[word] = ranked[r].ent;
      records.push({
        word: word,
        bits: ranked[r].ent,
        cand: ranked[r].cand || 0,
        exp: ranked[r].exp || 0,
        i: orderOf[ranked[r].idx] != null ? orderOf[ranked[r].idx] : r
      });
    }
    var chosen = Core.chooseOpenerList({
      declared: declared,
      authored: authored,
      scores: records,
      capped: capped,
      limit: limit
    });
    return { words: chosen.words, bits: bits, capped: chosen.capped, source: chosen.source };
  };

  root.SolverGauntlet = Gauntlet;
  if (typeof module !== 'undefined' && module.exports) module.exports = Gauntlet;
})(typeof self !== 'undefined' ? self : this);
