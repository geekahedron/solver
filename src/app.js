/* Wordle-style Solver — UI. Pools, clues, and scoring go through SolverEngine. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var Core = window.SolverCore;
  var Pack = window.SolverPack;
  var Renderers = window.SolverRenderers;
  var TreeStatus = window.SolverTreeStatus;
  var Gauntlet = window.SolverGauntlet;
  if (!TreeStatus) throw new Error('tree-status.js failed to load');
  if (!Gauntlet) throw new Error('gauntlet.js failed to load');
  var LS_KEY = 'geek-solver-packs-v1', LS_JSON = 'geek-solver-json-packs-v1', LS_STATE = 'geek-solver-state-v1';

  var BUILTIN = [
    { id: 'nyt', name: 'Wordle — NYT WordleBot lists (live)', manifest: 'packs/wordle-nyt.json', variant: 'wordle-nyt', remote: true },
    { id: 'en5', name: 'ENABLE — English 5-letter (reference)', variant: 'wordle-en-5' },
    { id: 'en4', name: 'ENABLE — English 4-letter', variant: 'wordle-en-4' },
    { id: 'en6', name: 'ENABLE — English 6-letter', variant: 'wordle-en-6' },
    { id: 'en7', name: 'ENABLE — English 7-letter', variant: 'wordle-en-7' },
    { id: 'en8', name: 'ENABLE — English 8-letter', variant: 'wordle-en-8' },
    { id: 'dungleon', name: 'Dungleon', manifest: 'packs/dungleon.json', variant: 'dungleon' },
    { id: 'blank', name: 'Custom — paste / upload your own lists', blank: true },
    { id: 'digits', name: 'Custom digits (0-9) — paste your list', blank: true, preset: { L: 5, alpha: '0123456789' } },
    { id: 'tokens', name: 'Custom tokens (cards, emoji…) — paste your list', blank: true, preset: { tok: true, alpha: '', ci: false } }
  ];

  var cfg = { L: 5, alpha: 'abcdefghijklmnopqrstuvwxyz', ci: true, tok: false, rule: 'wordle', valid: 'both',
    mode: 'avg', hard: 'off', ansOnly: false, max: 12000, top: 15, notation: 'GYB',
    layer: 'known', guessMode: 'dictionary', page: 'both',
    guarantee: false, steps: 6, stepsTouched: false, treePolicy: 'worst',
    nytAnswers: 'with-ed', nytGuesses: 'all', images: true, keyboardOpen: null, cake: false };
  var packId = 'nyt';
  var readyPackId = null;
  var keepPackWarn = false;
  var packWarn = '';
  var nytWant = { answers: 'with-ed', guesses: 'all' };
  var nytLoaded = null;
  var nytCache = Object.create(null);
  var nytServerPayload = null;
  var nytCheckNow = false;
  var nytFilling = false;
  var packGuessDefault = null;
  var engine = null;
  var packPhase = 'idle';
  var packError = '';
  var packGen = 0;
  var clues = [];
  var gauntlet = { mode: 'normal', focus: 0, floors: [] };
  var gauntletView = null;
  var gauntletOpenerCache = { gen: -1, map: Object.create(null) };
  function blankGauntletFloor(list) {
    return { clues: list || [], solution: '', draftGuess: '', draftPat: '', previewDigits: null };
  }
  gauntlet.floors.push(blankGauntletFloor(clues));
  gauntlet.floors.push(blankGauntletFloor());
  gauntlet.floors.push(blankGauntletFloor());
  var remaining = [];
  var remKnown = [];
  var remTheo = [];
  var lastTop = [], selectedKey = null, autoSel = true, bdFilterPat = null;
  var worker = null, reqId = 0, scoreTimer = null;
  var treeWorker = null, treeReq = 0, treeResult = null, treeSig = '', treePath = [], treeOnlyOver = false, treeListOpen = false;
  var treeQueue = null, treeFlushToken = 0, scanJob = null;
  var SCAN_EXTRA_MAX_REM = 16, SCAN_EXTRA_CAP = 40;
  var openerWords = [];
  var openerBits = Object.create(null);
  var openerSource = 'pack';
  var openerCapped = false;
  var openerPackSeen = -1;
  var scanMarks = Object.create(null);

  function inferGuessMode() {
    if (cfg.ansOnly) return 'answersOnly';
    if (cfg.hard === 'strict') return 'hard';
    if (cfg.valid === 'any') return 'any';
    return 'dictionary';
  }

  function activePack() {
    return engine ? engine.pack : Pack.fromCustom({
      length: cfg.L, alphabet: cfg.alpha, caseInsensitive: cfg.ci, tokens: cfg.tok, rule: cfg.rule
    });
  }

  function parsePat(s) {
    var clue = Pack.parseClue(s, activePack());
    return clue && clue.digits && clue.digits.length === cfg.L ? clue.digits : null;
  }
  function digitsToPat(d) { return Pack.digitsToPat(d, engine ? engine.clueBase : 3); }
  function patToDigits(p) { return Pack.patToDigits(p, cfg.L, engine ? engine.clueBase : 3); }
  function showWord(w) {
    w = w == null ? '' : String(w);
    if (engine && engine.pack.caseInsensitive === false) return w;
    return w.toUpperCase();
  }
  function foldWord(s) {
    s = (s || '').trim();
    if (!engine || engine.pack.caseInsensitive !== false) return s.toLowerCase();
    return s;
  }
  function patCode(d) {
    var id = engine ? engine.pack.clueRenderer : 'clues/wordle-gyb';
    return Renderers.clueCode(id, d, cfg.notation, engine && engine.pack);
  }
  function showImages() {
    return cfg.images !== false && !!(engine && engine.pack && engine.pack.appearance);
  }
  function artOpts(extra) {
    var o = Object.assign({}, extra || {});
    if (engine && engine.pack) o.marks = engine.pack.clueAlphabet;
    if (showImages()) {
      o.appearance = engine.pack.appearance;
      o.showImages = true;
    }
    if (!o.surface) o.surface = o.art === 'sprite' ? 'keyboard' : 'tiles';
    return o;
  }
  function tilesHTML(syms, digits, opts) {
    var id = engine ? engine.pack.tokenRenderer : 'tiles/letters';
    var o = artOpts(opts);
    if (opts && opts.art) o.art = opts.art;
    if (opts && opts.interactive) o.interactive = true;
    return Renderers.tiles(id, syms, digits, o);
  }
  function entityFor(sym) {
    var app = engine && engine.pack && engine.pack.appearance;
    if (!app || !app.entities || sym == null || sym === '') return null;
    return app.entities[sym] || null;
  }
  function entityAccessibleName(sym) {
    var ent = entityFor(sym);
    var label = ent && (ent.label || ent.title);
    if (label && label !== sym) return label + ' (' + sym + ')';
    return String(sym);
  }
  function wordHTML(word) {
    var shown = showWord(word);
    if (!showImages()) return esc(word);
    var tokens = Pack.parseWord(word, engine.pack);
    if (!tokens.length) return esc(word);
    return Renderers.wordArt(tokens, artOpts({ title: shown, art: 'sprite' }));
  }
  function esc(s) { return Renderers.esc(s); }

  function validityNote(key) {
    return engine ? engine.validityNote(key, cfg) : '';
  }

  // ---------- rendering ----------
  var previewDigits = null;
  function renderPreview() {
    var syms = Pack.parseWord($('clueGuess').value, activePack()).slice(0, cfg.L);
    while (syms.length < cfg.L) syms.push('');
    var pd = parsePat($('cluePat').value);
    if (pd) previewDigits = pd;
    if (!previewDigits || previewDigits.length !== cfg.L) previewDigits = new Array(cfg.L).fill(0);
    $('cluePreview').innerHTML = tilesHTML(syms, previewDigits, { interactive: true });
  }
  $('cluePreview').addEventListener('click', function (e) {
    var t = e.target.closest('.tile'); if (!t) return;
    var i = +t.dataset.i;
    var marks = (engine && engine.pack && engine.pack.clueAlphabet) || [{ value: 0 }, { value: 1 }, { value: 2 }];
    var cur = previewDigits[i] || 0, k, idx = 0;
    for (k = 0; k < marks.length; k++) if (marks[k].value === cur) idx = k;
    previewDigits[i] = marks[(idx + 1) % marks.length].value;
    $('cluePat').value = patCode(previewDigits).replace(/⬛/g, 'b').replace(/🟨/g, 'y').replace(/🟩/g, 'g');
    renderPreview();
  });

  function renderClues() {
    $('clueList').innerHTML = clues.map(function (c, i) {
      var left = (c.afterKnown != null && c.afterTheo != null && c.afterKnown !== c.afterTheo)
        ? (c.afterKnown.toLocaleString() + ' known · ' + c.afterTheo.toLocaleString() + ' theoretical left after')
        : ((c.after == null ? '' : c.after.toLocaleString() + ' left after'));
      return '<div class="clue-row">' + tilesHTML(c.syms, c.digits) + '<span class="meta">' + esc(patCode(c.digits)) +
        (c.note ? ' · <span class="warn">' + esc(c.note) + '</span>' : '') + (left ? ' · ' + left : '') + '</span>' +
        '<button class="ghost mini" data-del="' + i + '">✕</button></div>';
    }).join('') || '<p class="muted small">No clues yet — showing best opening guesses.</p>';
  }
  $('clueList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-del]'); if (!b) return;
    clues.splice(+b.dataset.del, 1); refresh();
  });

  function listHTML(idxs) {
    var useArt = showImages() && idxs.length <= 400;
    var shown = idxs.slice(0, 3000).map(function (i) {
      var w = engine.keys[i];
      return '<div>' + (useArt ? wordHTML(w) : esc(w)) + '</div>';
    }).join('');
    return shown + (idxs.length > 3000 ? '<div class="muted">… +' + (idxs.length - 3000) + ' more</div>' : '');
  }
  function renderRemaining() {
    if (!engine) return;
    var active = remaining.length;
    var denom = cfg.layer === 'theoretical' ? engine.theoreticalIdx.length
      : (cfg.layer === 'preferred' && !remKnown.length ? engine.theoreticalIdx.length : engine.nKnown);
    $('remCount').textContent = active.toLocaleString() + (denom ? ' / ' + denom.toLocaleString() : '');
    var layerName = cfg.layer === 'theoretical' ? 'theoretical' : (cfg.layer === 'preferred' ? 'known preferred' : 'known answers');
    $('remLayers').textContent = 'Known ' + remKnown.length.toLocaleString() + ' / ' + engine.nKnown.toLocaleString() +
      ' · Theoretical ' + remTheo.length.toLocaleString() + ' / ' + engine.theoreticalIdx.length.toLocaleString() +
      ' · scoring ' + layerName;
    if ($('remDetails').open) {
      $('remList').classList.toggle('art', showImages() && remKnown.length <= 400);
      $('remList').innerHTML = listHTML(remKnown);
    }
    if ($('remTheo').open) {
      $('remTheoList').classList.toggle('art', showImages() && remTheo.length <= 400);
      $('remTheoList').innerHTML = listHTML(remTheo);
    }
  }
  $('remDetails').addEventListener('toggle', renderRemaining);
  $('remTheo').addEventListener('toggle', renderRemaining);

  function fmt(x, d) { return (Math.round(x * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d); }
  function stepsText(s) {
    if (!s || s.steps == null || s.steps !== s.steps || !isFinite(s.steps)) return '–';
    return fmt(s.steps, 2) + (s.approx ? '≈' : '');
  }
  function maxStepsCell(s) {
    var text = '–', loose = false, bad = false;
    if (s.maxExact && s.maxSteps != null) text = String(s.maxSteps);
    else if (s.maxSteps != null) { text = '≤' + s.maxSteps; loose = true; }
    else if (s.maxUncertain) {
      text = (s.maxLower > 1 && isFinite(s.maxLower)) ? ('≥' + s.maxLower + '?') : '?';
      loose = true;
    } else if (s.maxExceeds && s.maxLower != null && isFinite(s.maxLower)) {
      text = '≥' + s.maxLower;
    }
    if (s.maxSteps != null && s.maxSteps > cfg.steps) bad = true;
    if ((s.maxExact || s.maxExceeds) && s.maxLower > cfg.steps) bad = true;
    var cls = bad ? ' class="warn"' : (loose ? ' class="depth-loose"' : '');
    return '<td' + cls + '>' + text + '</td>';
  }
  function renderSuggestions(top) {
    lastTop = top;
    var tb = $('sugTable').tBodies[0];
    tb.innerHTML = top.map(function (s, i) {
      var k = engine.keys[s.idx];
      return '<tr data-key="' + esc(k) + '"' + (k === selectedKey ? ' class="sel"' : '') + '><td>' + (i + 1) + '</td><td>' + wordHTML(k) + '</td><td>' + stepsText(s) + '</td><td>' + fmt(s.exp, 2) +
        '</td><td>' + s.worst + '</td>' + maxStepsCell(s) + '<td>' + s.splits + '</td><td>' + fmt(s.ent, 2) + '</td><td>' + (s.cand ? '<span class="ok">✓</span>' : '') + '</td></tr>';
    }).join('');
    var col = { steps: 2, avg: 3, minimax: 4, splits: 6, entropy: 7 }[cfg.mode];
    Array.prototype.forEach.call($('sugTable').tHead.rows[0].cells, function (th, i) { th.classList.toggle('sortcol', i === col); });
  }
  $('sugTable').tBodies[0].addEventListener('click', function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    autoSel = false; $('bdGuess').value = tr.dataset.key; analyze(tr.dataset.key, true);
  });

  function analyze(raw, scroll) {
    if (!engine) return;
    var g = engine.encode(raw);
    if (g.err) { $('bdSummary').innerHTML = '<span class="warn">' + esc(g.err) + '</span>'; $('bdRows').innerHTML = ''; return; }
    selectedKey = g.key;
    Array.prototype.forEach.call($('sugTable').tBodies[0].rows, function (tr) { tr.classList.toggle('sel', tr.dataset.key === g.key); });
    var buckets = new Map();
    remaining.forEach(function (r) {
      var p = engine.feedbackPat(g.ids, r);
      var a = buckets.get(p);
      if (!a) buckets.set(p, a = []);
      a.push(r);
    });
    var n = remaining.length, allGreen = digitsToPat(new Array(cfg.L).fill(2));
    var rows = Array.from(buckets.entries()).sort(function (a, b) { return b[1].length - a[1].length || a[0] - b[0]; });
    var sumSq = 0, worst = 0, ent = 0;
    rows.forEach(function (r) { var c = r[1].length, p = c / n; ent -= p * Math.log2(p); if (r[0] !== allGreen) { sumSq += c * c; worst = Math.max(worst, c); } });
    var note = validityNote(g.key);
    var hardBreak = false;
    if (cfg.hard !== 'off' && engine.keyIdx.has(g.key)) {
      var gi = engine.keyIdx.get(g.key);
      hardBreak = !(cfg.hard === 'wordle' ? engine.wordleHardOk(gi, clues) : engine.consistentAllIndex(gi, clues));
    }
    $('bdTitle').innerHTML = '· ' + tilesHTML(g.syms, null);
    var scoredRow = null;
    for (var si = 0; si < lastTop.length; si++) if (engine.keys[lastTop[si].idx] === g.key) scoredRow = lastTop[si];
    var stepsBit = (scoredRow && stepsText(scoredRow) !== '–') ? (' · <b>' + stepsText(scoredRow) + '</b> expected guesses to solve') : '';
    var maxBit = '';
    if (scoredRow && scoredRow.maxExact && scoredRow.maxSteps != null) maxBit = ' · max steps ' + scoredRow.maxSteps;
    else if (scoredRow && scoredRow.maxSteps != null) maxBit = ' · max steps ≤' + scoredRow.maxSteps;
    else if (scoredRow && scoredRow.maxUncertain) maxBit = ' · max steps ?';
    $('bdSummary').innerHTML = n ? ('If you guess <b>' + esc(showWord(g.key)) + '</b> with ' + n + ' answers possible: ' + rows.length + ' possible results · expected ' + fmt(n ? sumSq / n : 0, 2) +
      ' left · largest group ' + worst + ' · ' + fmt(ent, 2) + ' bits' + stepsBit + maxBit + (buckets.has(allGreen) ? ' · <span class="ok">could be the answer</span>' : '') +
      (hardBreak ? ' · <span class="warn">breaks hard mode</span>' : '') +
      (note ? ' · <span class="warn">' + esc(note) + '</span>' : '')) : 'No answers remain — check your clues.';
    var html = rows.map(function (r) {
      var d = patToDigits(r[0]), words = r[1].map(function (i) { return engine.keys[i]; });
      if (bdFilterPat !== null && r[0] !== bdFilterPat) return '';
      var open = bdFilterPat !== null || rows.length === 1 ? ' open' : '';
      return '<details class="bd-row"' + open + '><summary>' + tilesHTML(g.syms, d) + '<span class="code">' + esc(patCode(d)) + '</span><span class="cnt">' +
        (r[0] === allGreen ? 'solved' : words.length + ' left') + '</span><span class="preview">' + esc(words.slice(0, 12).join(' ')) + (words.length > 12 ? ' …' : '') +
        '</span><button class="ghost mini" data-use="' + r[0] + '" title="Add this result as a clue">use</button></summary><div class="wordlist">' +
        words.slice(0, 2000).map(function (w) {
          return '<div>' + (showImages() && words.length <= 200 ? wordHTML(w) : esc(w)) + '</div>';
        }).join('') + (words.length > 2000 ? '<div class="muted">…</div>' : '') + '</div></details>';
    }).join('');
    if (bdFilterPat !== null && !html) html = '<p class="muted">That result can\'t happen — 0 answers remain for it.</p>';
    $('bdRows').innerHTML = html;
    $('bdRows').dataset.guess = g.key;
    if (scroll) $('bdCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('bdRows').addEventListener('click', function (e) {
    var b = e.target.closest('[data-use]'); if (!b) return;
    e.preventDefault();
    addClue($('bdRows').dataset.guess, patToDigits(+b.dataset.use));
  });
  $('bdBtn').addEventListener('click', function () { autoSel = false; analyze($('bdGuess').value, false); });
  $('bdGuess').addEventListener('keydown', function (e) { if (e.key === 'Enter') { autoSel = false; analyze($('bdGuess').value, false); } });
  $('bdFilter').addEventListener('input', function () {
    var v = $('bdFilter').value.trim(), d = v ? parsePat(v) : null;
    bdFilterPat = d ? digitsToPat(d) : null;
    if ($('bdRows').dataset.guess) analyze($('bdRows').dataset.guess, false);
  });

  function addClue(raw, digits) {
    if (!engine) return false;
    var g = engine.encode(raw);
    if (g.err) { alert('Guess ' + g.err); return false; }
    if (!digits) { alert('Result must be ' + cfg.L + ' codes, e.g. ' + 'bgybb'.slice(0, cfg.L)); return false; }
    var made = engine.makeClue(g.key, digits);
    clues.push({ key: made.key, ids: made.ids, syms: made.syms, digits: made.digits, pat: made.pat, word: made.word, clue: made.clue, note: validityNote(made.key) });
    $('clueGuess').value = ''; $('cluePat').value = ''; previewDigits = null;
    bdFilterPat = null; $('bdFilter').value = '';
    refresh();
    return true;
  }
  $('addClueBtn').addEventListener('click', function () {
    var d = parsePat($('cluePat').value) || ($('cluePat').value.trim() === '' && previewDigits && previewDigits.length === cfg.L ? previewDigits.slice() : null);
    if (addClue($('clueGuess').value, d)) $('clueGuess').focus();
  });
  ['clueGuess', 'cluePat'].forEach(function (id) {
    $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') { if (id === 'clueGuess' && !$('cluePat').value) $('cluePat').focus(); else $('addClueBtn').click(); } });
    $(id).addEventListener('input', renderPreview);
  });
  $('undoBtn').addEventListener('click', function () { clues.pop(); refresh(); });
  $('clearBtn').addEventListener('click', function () { clues.splice(0, clues.length); refresh(); });

  // ---------- scoring (worker) ----------
  function layerLabel() {
    if (cfg.layer === 'theoretical') return 'theoretical solutions';
    if (cfg.layer === 'preferred' && !remKnown.length) return 'theoretical solutions';
    return 'known answers';
  }
  function cancelScore() {
    reqId++;
    clearTimeout(scoreTimer);
    if (worker) { worker.terminate(); worker = null; }
  }
  function scheduleScore() {
    markTreeStale();
    if (cfg.page === 'tree') return;
    clearTimeout(scoreTimer);
    scoreTimer = setTimeout(runScore, 120);
  }
  function stepsPayload() {
    var dict = null;
    if (cfg.guessMode !== 'answersOnly') {
      if (cfg.valid === 'answers' && cfg.guessMode !== 'any') dict = Int32Array.from(engine.knownIdx);
      else {
        dict = new Int32Array(engine.nWords);
        for (var i = 0; i < engine.nWords; i++) dict[i] = i;
      }
    }
    return {
      guessMode: cfg.guessMode,
      hard: cfg.hard,
      dict: dict,
      clues: clues.map(function (c) {
        return { ids: Array.prototype.slice.call(c.ids), pat: c.pat, digits: c.digits.slice() };
      })
    };
  }
  function runScore() {
    var layerHasRows = false;
    if (engine) {
      if (cfg.layer === 'theoretical' || cfg.layer === 'preferred') layerHasRows = !!(engine.nKnown || engine.theoreticalIdx.length);
      else layerHasRows = !!engine.nKnown;
    }
    if (!layerHasRows) {
      renderSuggestions([]); $('scoreStatus').textContent = 'Load an answer list to get suggestions.'; return;
    }
    if (!remaining.length) { renderSuggestions([]); $('scoreStatus').innerHTML = '<span class="warn">No answers fit these clues.</span>'; return; }
    var bp = engine.buildPool({
      valid: cfg.valid, hard: cfg.hard, ansOnly: cfg.ansOnly, guessMode: cfg.guessMode,
      remaining: remaining, clues: clues, max: cfg.max
    });
    if (!bp.pool.length) { renderSuggestions([]); $('scoreStatus').textContent = 'No allowed guesses under these settings.'; return; }
    var isCand = new Uint8Array(engine.nWords);
    remaining.forEach(function (i) { if (i < isCand.length) isCand[i] = 1; });
    var id = ++reqId;
    var stepInfo = stepsPayload();
    var msg = {
      id: id, U: engine.U, L: cfg.L, K: engine.syms.length, rule: engine.feedbackRule,
      rem: Int32Array.from(remaining), pool: Int32Array.from(bp.pool), isCand: isCand,
      mode: cfg.mode, topN: cfg.top,
      guessIdx: stepInfo.dict || Int32Array.from(engine.guessIdx),
      dict: stepInfo.dict, clues: stepInfo.clues, hard: cfg.hard, guessMode: cfg.guessMode,
      budget: cfg.steps, guarantee: !!cfg.guarantee,
      // Short clock so a long Max steps search fails closed instead of freezing.
      // Expected-steps uses its own limits and is not cut by this clock.
      timeCapMs: 180, beam: 12, nodeCap: 4000, exactLimit: 16, autoDepthLimit: 20,
      checkLimit: 40, checkLimitLarge: 16
    };
    if (cfg.mode === 'steps') msg.steps = stepInfo;
    if (engine.feedbackSource) {
      msg.feedbackSource = engine.feedbackSource;
      msg.syms = engine.syms;
      msg.clueBase = engine.clueBase;
      msg.greenDigit = engine.greenDigit;
      msg.correctValues = engine.correctValues;
      msg.revealedValues = engine.revealedValues;
    }
    var label = 'Scoring ' + bp.pool.length.toLocaleString() + ' guesses × ' + remaining.length.toLocaleString() + ' ' + layerLabel() +
      (bp.pruned ? ' (pre-filtered from ' + bp.total.toLocaleString() + ' by letter coverage — raise “Max guesses to score” for a full search)' : '') +
      (cfg.mode === 'steps' ? ' · expected steps' : '') +
      (cfg.guarantee ? (' · guarantee ≤ ' + cfg.steps + ' steps') : '');
    $('scoreStatus').innerHTML = esc(label) + '…<div class="bar"><i id="pbar"></i></div>';
    function depthNote(depth) {
      if (!depth || !depth.on) {
        if (depth && !depth.computed && remaining.length > 20) return ' Max steps is filled once 20 or fewer answers remain, or when the guarantee is on.';
        return '';
      }
      var note = ' Checked ' + depth.checked + ' by the current ranking: kept ' + depth.kept;
      if (depth.exceeded) note += ', ' + depth.exceeded + ' proved over ' + cfg.steps;
      if (depth.uncertain) note += ', ' + depth.uncertain + ' unproved';
      note += '.';
      if (depth.approx) note += ' Max steps search was approximate and fail-closed: a guess is kept only when a line was proved.';
      if (depth.limited) note += ' Stopped before the whole list; a later guess was not checked.';
      if (!depth.kept) note += ' Nothing proved a finish within n under these rules.';
      return note;
    }
    var done = function (top, ms, depth) {
      if (id !== reqId) return;
      renderSuggestions(top);
      var tail = '';
      if (cfg.mode === 'steps') {
        var approxN = 0, exactN = 0;
        top.forEach(function (s) {
          if (s.steps == null || !isFinite(s.steps)) return;
          if (s.approx) approxN++; else exactN++;
        });
        if (approxN && !exactN) tail = ' Steps are approximate (see the note under the table).';
        else if (approxN) tail = ' Steps marked ≈ are approximate.';
        else if (exactN) tail = ' Steps are exact for this set.';
      }
      $('scoreStatus').textContent = label.replace('Scoring', 'Scored') + ' in ' + ms + ' ms.' + tail + depthNote(depth);
      if ((autoSel || !selectedKey) && top.length) { $('bdGuess').value = engine.keys[top[0].idx]; analyze(engine.keys[top[0].idx], false); }
      else if (selectedKey) analyze(selectedKey, false);
    };
    if (worker) { worker.terminate(); worker = null; }
    try {
      if (location.protocol === 'file:') throw new Error('no worker on file://');
      worker = new Worker('worker.js');
      worker.onmessage = function (e) {
        var d = e.data; if (d.id !== reqId) return;
        if (d.type === 'progress') {
          var b = $('pbar');
          if (b) {
            var frac = d.done / Math.max(1, d.total);
            var stepsOn = cfg.mode === 'steps';
            var guar = !!cfg.guarantee;
            var pct;
            if (!stepsOn && !guar) pct = 100 * frac;
            else if (stepsOn && !guar) pct = d.phase === 'steps' ? 70 + 30 * frac : 70 * frac;
            else if (!stepsOn && guar) pct = d.phase === 'depth' ? 70 + 30 * frac : 70 * frac;
            else if (d.phase === 'depth') pct = 70 + 30 * frac;
            else if (d.phase === 'steps') pct = 40 + 30 * frac;
            else pct = 40 * frac;
            b.style.width = pct + '%';
          }
        }
        else { done(d.top, d.ms, d.depth); worker.terminate(); worker = null; }
      };
      worker.onerror = function () { worker = null; syncScore(); };
      worker.postMessage(msg);
    } catch (err) { syncScore(); }
    function syncScore() {
      setTimeout(function () {
        var t0 = Date.now();
        var hooks = engine.scoringHooks;
        var sc = Core.scorePool(msg.U, msg.L, msg.K, msg.rule, msg.rem, msg.pool, msg.isCand, null, hooks);
        if (msg.mode === 'steps') {
          var st = msg.steps || {};
          Core.attachExpectedSteps(sc, msg.U, msg.L, msg.K, msg.rule, msg.rem, msg.pool, {
            guessMode: st.guessMode, hard: st.hard, dict: st.dict, clues: st.clues || [], hooks: hooks
          });
          msg.stepsAttached = true;
        }
        var finished = Core.finishScores(sc, Object.assign({}, msg, { hooks: hooks }));
        done(finished.top, Date.now() - t0, finished.depth);
      }, 10);
    }
  }

  function gauntletFloors() {
    var n = engine && engine.pack && engine.pack.gauntlet && engine.pack.gauntlet.floors;
    if (n >= 2 && n <= 6) return n;
    return gauntlet.floors.length >= 2 ? gauntlet.floors.length : 3;
  }
  function ensureGauntletFloors(n) {
    if (!n || n < 2) n = 3;
    if (n > 6) n = 6;
    while (gauntlet.floors.length < n) gauntlet.floors.push(blankGauntletFloor());
    while (gauntlet.floors.length > n) gauntlet.floors.pop();
    if (!gauntlet.floors[0]) gauntlet.floors[0] = blankGauntletFloor(clues);
  }
  function gauntletSupported() {
    return !!(engine && engine.pack && engine.pack.gauntlet && engine.pack.gauntlet.floors >= 2);
  }
  function gauntletActive() {
    return gauntlet.mode === 'gauntlet' && gauntletSupported();
  }
  function syncGauntletMode() {
    ensureGauntletFloors(gauntletFloors());
    if (!gauntletSupported()) gauntlet.mode = 'normal';
    if (!gauntletActive()) {
      clues = gauntlet.floors[0].clues;
      return;
    }
    if (gauntlet.focus < 0 || gauntlet.focus >= gauntlet.floors.length) gauntlet.focus = 0;
    clues = gauntlet.floors[gauntlet.focus].clues;
  }
  function syncGauntletChrome() {
    var supported = gauntletSupported();
    var on = supported && gauntlet.mode === 'gauntlet';
    document.body.setAttribute('data-gauntlet', on ? 'on' : 'off');
    var modes = $('gauntletModes');
    if (modes) {
      modes.hidden = !supported;
      Array.prototype.forEach.call(modes.querySelectorAll('button'), function (b) {
        var which = b.getAttribute('data-gauntlet');
        var active = on ? which === 'gauntlet' : which === 'normal';
        b.classList.toggle('on', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }
    var board = $('gauntletBoard');
    if (board) board.hidden = !on;
    var heading = $('cluesHeading');
    if (heading) heading.textContent = on ? 'Keyboard' : 'Clues so far';
  }
  function reencodeClueList(list) {
    var next = [];
    list.forEach(function (c) {
      var g = engine.encode(c.key);
      if (!g.err && c.digits && c.digits.length === cfg.L) next.push(Object.assign(c, { ids: g.ids, syms: g.syms, word: g.word }));
    });
    list.splice(0, list.length);
    next.forEach(function (c) { list.push(c); });
  }
  function restoreClueList(list, saved) {
    list.splice(0, list.length);
    (saved || []).forEach(function (c) {
      if (!c || !engine) return;
      var g = engine.encode(c.key);
      if (!g.err && c.digits && c.digits.length === cfg.L) {
        var made = engine.makeClue(g.key, c.digits);
        list.push({ key: made.key, ids: made.ids, syms: made.syms, digits: made.digits, pat: made.pat, word: made.word, clue: made.clue, note: validityNote(made.key) });
      }
    });
  }
  function pinnedKey(text) {
    if (!text || !String(text).trim() || !engine) return null;
    var enc = engine.encode(String(text).trim());
    return enc.err ? null : enc.key;
  }
  function buildGauntletView() {
    var raw = gauntlet.floors.map(function (f) {
      var parts = engine.replay(f.clues, cfg.layer);
      return {
        known: parts.known,
        theoretical: parts.theoretical,
        solution: pinnedKey(f.solution),
        clueSolution: Gauntlet.solvedClue(f.clues, engine.correctValues)
      };
    });
    var propagated = Gauntlet.propagate({
      floors: raw,
      tokensOf: function (i) { return engine.tokens[i]; },
      tokensOfKey: function (key) { return Pack.parseWord(key, engine.pack); },
      keyOf: function (i) { return engine.keys[i]; },
      layer: cfg.layer || 'known',
      order: Pack.alphabetTokens(engine.pack),
      length: cfg.L
    });
    propagated.floors.forEach(function (floor, i) {
      floor.clueKnown = raw[i].known;
      floor.clueTheoretical = raw[i].theoretical;
      floor.rawKnown = raw[i].known.length;
      floor.rawTheoretical = raw[i].theoretical.length;
    });
    return propagated;
  }
  function openerSig(rem) {
    var h1 = 2166136261, h2 = 0, i, x;
    for (i = 0; i < rem.length; i++) {
      x = rem[i] | 0;
      h1 ^= x;
      h1 = (h1 * 33 + x) | 0;
      h2 = (h2 + x) | 0;
    }
    return rem.length + ':' + h1 + ':' + h2;
  }
  function floorOpeners(rem) {
    if (gauntletOpenerCache.gen !== packGen) {
      gauntletOpenerCache.gen = packGen;
      gauntletOpenerCache.map = Object.create(null);
    }
    var sig = openerSig(rem) + (packDeclaredOpeners() ? ':d' : ':g');
    if (gauntletOpenerCache.map[sig]) return gauntletOpenerCache.map[sig];
    var ranked = Gauntlet.rankOpeners(Core, {
      U: engine.U,
      L: cfg.L,
      K: engine.syms.length,
      rule: engine.feedbackRule,
      hooks: engine.scoringHooks,
      rem: rem,
      guessIdx: engine.guessIdx,
      keys: engine.keys,
      lookup: function (w) { return engine.keyIdx.has(w) ? engine.keyIdx.get(w) : -1; },
      declared: packDeclaredOpeners(),
      authored: legalAuthoredOpeners()
    });
    gauntletOpenerCache.map[sig] = ranked;
    return ranked;
  }
  function entityChips(syms) {
    if (!syms || !syms.length) return '';
    return '<span class="gauntlet-chips">' + syms.map(function (s) {
      return '<span class="gauntlet-chip" title="' + esc(entityAccessibleName(s)) + '">' +
        tilesHTML([s], null) + '<span class="gauntlet-code">' + esc(s) + '</span></span>';
    }).join('') + '</span>';
  }
  function scoringKnownSide(floor) {
    if (cfg.layer === 'theoretical') return false;
    if (cfg.layer === 'preferred' && !floor.known.length) return false;
    return true;
  }
  function layerPhrase() {
    if (cfg.layer === 'theoretical') return 'theoretical';
    if (cfg.layer === 'preferred') return 'known-preferred';
    return 'known';
  }
  function mustLine(label, must, status) {
    if (status === 'impossible' || !must || !must.length) {
      return '<p class="gauntlet-must warn">' + esc(label) + ': no shared entity is still possible.</p>';
    }
    return '<p class="gauntlet-must">' + esc(label) + ' ' + entityChips(must) + '</p>';
  }
  function constraintBlock(index, floor) {
    var c = floor.constraint;
    var lead = '';
    var extra = '';
    if (!c || c.status === 'none') {
      lead = 'No shared-entity rule on floor 1. Solve it normally.';
    } else if (c.status === 'waiting') {
      lead = 'Floor 1 is still open, so this floor is not filtered yet.';
    } else if (c.status === 'impossible' && !c.layersDiffer) {
      lead = 'No entity is shared by the solved floors, so nothing on this floor can satisfy the rule.';
    } else if (index === 1) {
      lead = 'Must share an entity with floor 1.';
    } else if (c.partial) {
      lead = 'Earlier floors are not all solved, so the shared set below is a bound.';
      extra = index === 2
        ? 'Floor 2 is not solved yet, so this is a bound rather than the final shared set. It is every entity in floor 1’s solution that still appears in at least one remaining floor 2 candidate on this list. A dungeon stays only if it contains one of those entities — otherwise it cannot be in all three solutions. When floor 2 is solved, the set shrinks to the entities that are actually in both solutions.'
        : 'An earlier floor is still open, so this is a bound: entities from the solved floors that still appear in at least one remaining candidate of each unsolved earlier floor, on this list. Solving those floors replaces the bound with the exact shared entities.';
    } else {
      lead = 'Must contain an entity that is in every solved floor above.';
    }
    var html = '<p class="gauntlet-rule">' + esc(lead) + '</p>';
    if (c && c.status !== 'none' && c.status !== 'waiting' && !(c.status === 'impossible' && !c.layersDiffer)) {
      if (!c.layersDiffer) html += mustLine(index === 1 ? 'Must contain one of' : 'Must contain one of', c.must, c.status);
      else {
        var knownSide = scoringKnownSide(floor);
        html += mustLine('Known' + (knownSide ? ' (scoring)' : ''), c.knownMust, c.knownStatus);
        html += mustLine('Theoretical' + (knownSide ? '' : ' (scoring)'), c.theoreticalMust, c.theoreticalStatus);
      }
    }
    if (extra) html += '<p class="muted small">' + esc(extra) + '</p>';
    return html;
  }
  function solutionBlock(index, floor, state) {
    var html = '';
    var typed = state && state.solution ? String(state.solution).trim() : '';
    if (typed && !pinnedKey(typed)) {
      html += '<p class="muted small" id="gSolNote' + index + '">Enter ' + cfg.L + ' tokens. Later floors update when the solution is complete.</p>';
    } else html += '<p class="muted small" id="gSolNote' + index + '"></p>';
    if (floor.solution) {
      var why = floor.solutionSource === 'entered' ? 'the solution you entered'
        : floor.solutionSource === 'clue' ? 'the all-correct guess'
        : ('the only ' + layerPhrase() + ' answer left');
      var tokens = Pack.parseWord(floor.solution, engine.pack);
      html += '<p class="gauntlet-solved">Using ' + tilesHTML(tokens, null) + ' <span class="muted">(' + esc(why) + ').</span></p>';
      if (floor.solutionSource === 'entered') {
        var inList = false, i;
        for (i = 0; i < floor.clueKnown.length; i++) if (engine.keys[floor.clueKnown[i]] === floor.solution) inList = true;
        for (i = 0; i < floor.clueTheoretical.length; i++) if (engine.keys[floor.clueTheoretical[i]] === floor.solution) inList = true;
        if (!inList && (floor.rawKnown || floor.rawTheoretical)) {
          html += '<p class="warn small">This solution does not fit the clues on this floor. Later floors still use its entities.</p>';
        } else if (!inList && engine.rules && !engine.rules.validSolution(tokens, engine)) {
          html += '<p class="warn small">This is not a legal dungeon under the pack rules. Later floors still use its entities.</p>';
        }
      }
    } else {
      var hint = '';
      if (cfg.layer === 'theoretical' && floor.clueKnown.length === 1) {
        hint = 'The known list is down to ' + engine.keys[floor.clueKnown[0]] + '. Enter it as the solution, or switch the solution layer to Known, to filter later floors.';
      } else if (cfg.layer === 'known' && floor.clueTheoretical.length === 1 && floor.clueKnown.length !== 1) {
        hint = 'The theoretical list is down to ' + engine.keys[floor.clueTheoretical[0]] + '. Enter it as the solution, or switch the solution layer to Theoretical, to filter later floors.';
      }
      if (hint) html += '<p class="muted small">' + esc(hint) + '</p>';
    }
    return html;
  }
  function floorClueRows(list) {
    if (!list.length) return '<p class="muted small">No clues yet.</p>';
    return list.map(function (c, n) {
      var left = (c.afterKnown != null && c.afterTheo != null && c.afterKnown !== c.afterTheo)
        ? (c.afterKnown.toLocaleString() + ' known · ' + c.afterTheo.toLocaleString() + ' theoretical left after the clue')
        : (c.after == null ? '' : c.after.toLocaleString() + ' left after the clue');
      return '<div class="clue-row">' + tilesHTML(c.syms, c.digits) + '<span class="meta">' + esc(patCode(c.digits)) +
        (c.note ? ' · <span class="warn">' + esc(c.note) + '</span>' : '') +
        (left ? ' · ' + esc(left) : '') + '</span><button type="button" class="ghost mini" data-del="' + n + '">✕</button></div>';
    }).join('');
  }
  function floorPreviewHTML(state) {
    var syms = Pack.parseWord(state.draftGuess || '', activePack()).slice(0, cfg.L);
    var digits = state.previewDigits && state.previewDigits.length === cfg.L ? state.previewDigits : new Array(cfg.L).fill(0);
    var parsed = parsePat(state.draftPat || '');
    if (parsed) digits = parsed;
    while (syms.length < cfg.L) syms.push('');
    return tilesHTML(syms, digits, { interactive: true });
  }
  function listDetails(floorIndex, which, idxs, label) {
    var open = idxs.length > 0 && idxs.length <= 40;
    var art = open && showImages() && idxs.length <= 400 ? ' art' : '';
    return '<details class="gauntlet-list"' + (open ? ' open' : '') + '><summary>' + esc(label) +
      '</summary><div class="wordlist' + art + '" data-floor="' + floorIndex + '" data-which="' + which + '"' +
      (open ? ' data-filled="1"' : '') + '>' + (open ? listHTML(idxs) : '') + '</div></details>';
  }
  function countLabel(name, shown, raw, total) {
    var text = name + ' (' + shown.toLocaleString() + ' / ' + total.toLocaleString();
    if (raw !== shown) text += ', ' + raw.toLocaleString() + ' fit the clues';
    return text + ')';
  }
  function openerBlock(floor) {
    var ranked = floorOpeners(floor.active);
    if (!ranked.words.length) return '<p class="muted small">No openers to suggest for this floor.</p>';
    var rows = ranked.words.map(function (w, n) {
      var bits = ranked.bits[w];
      var text = (bits == null || bits !== bits) ? '–' : fmt(bits, 2);
      return '<tr data-pick="' + esc(w) + '"><td>' + (n + 1) + '</td><td>' + wordHTML(w) + '</td><td>' + text + '</td></tr>';
    }).join('');
    var note = ranked.source === 'pack'
      ? 'Openers come from this pack’s list, in that order. Bits are rescored against this floor’s ' + floor.active.length.toLocaleString() + ' answers.'
      : 'Top ' + ranked.words.length + ' by expected information against this floor’s ' + floor.active.length.toLocaleString() +
        ' answers: −∑ p log₂ p, the same score Scan openers uses.' +
        (ranked.capped ? ' The candidate list was capped so a large pool would not hang the page.' : '');
    return '<div class="tablewrap"><table class="data gauntlet-openers"><thead><tr><th>#</th><th>Opener</th><th>Bits</th></tr></thead><tbody>' +
      rows + '</tbody></table></div><p class="muted small">' + esc(note) + '</p>';
  }
  function renderGauntletFloor(index, floor) {
    var state = gauntlet.floors[index];
    var focused = index === gauntlet.focus;
    var ph = engine.pack.clueCaseSensitive ? 'rgyYG' : 'bgybb';
    var parts = [];
    parts.push('<section class="gauntlet-floor' + (focused ? ' focus' : '') + '" data-floor="' + index + '">');
    parts.push('<div class="gauntlet-head"><h3>Floor ' + (index + 1) + '</h3>');
    parts.push('<button type="button" class="ghost mini' + (focused ? ' on' : '') + '" data-focus="' + index + '" aria-pressed="' + (focused ? 'true' : 'false') + '">' +
      (focused ? 'Focused' : 'Focus for Analysis') + '</button></div>');
    parts.push(constraintBlock(index, floor));
    parts.push(solutionBlock(index, floor, state));
    parts.push('<div class="clue-entry">');
    parts.push('<input type="text" id="gGuess' + index + '" data-gauntlet-field="guess" data-floor="' + index + '" value="' + esc(state.draftGuess || '') + '" placeholder="guess" autocomplete="off" autocapitalize="off" spellcheck="false">');
    parts.push('<input type="text" id="gPat' + index + '" data-gauntlet-field="pat" data-floor="' + index + '" value="' + esc(state.draftPat || '') + '" placeholder="result (e.g. ' + ph.slice(0, cfg.L) + ')" autocomplete="off" autocapitalize="off" spellcheck="false">');
    parts.push('<button type="button" data-add="' + index + '">Add</button></div>');
    parts.push('<div class="tiles-preview gauntlet-preview" id="gPreview' + index + '" data-floor="' + index + '">' + floorPreviewHTML(state) + '</div>');
    parts.push('<div class="gauntlet-clues">' + floorClueRows(state.clues) + '</div>');
    parts.push('<div class="row-btns"><button type="button" class="ghost" data-undo="' + index + '">Undo last</button><button type="button" class="ghost" data-clear-clues="' + index + '">Clear clues</button></div>');
    parts.push('<label class="gauntlet-sol">Solution <input type="text" id="gSol' + index + '" data-gauntlet-field="solution" data-floor="' + index + '" value="' + esc(state.solution || '') + '" placeholder="known dungeon" autocomplete="off" autocapitalize="off" spellcheck="false">');
    parts.push(' <button type="button" class="ghost mini" data-clear-solution="' + index + '">Clear solution</button></label>');
    parts.push('<p class="muted small">Known ' + floor.known.length.toLocaleString() + ' / ' + engine.nKnown.toLocaleString() +
      ' · Theoretical ' + floor.theoretical.length.toLocaleString() + ' / ' + engine.theoreticalIdx.length.toLocaleString() +
      (floor.rawKnown !== floor.known.length || floor.rawTheoretical !== floor.theoretical.length
        ? ' · clues alone leave ' + floor.rawKnown.toLocaleString() + ' known and ' + floor.rawTheoretical.toLocaleString() + ' theoretical'
        : '') + '</p>');
    parts.push(listDetails(index, 'known', floor.known, countLabel('Known answers', floor.known.length, floor.rawKnown, engine.nKnown)));
    parts.push(listDetails(index, 'theoretical', floor.theoretical, countLabel('Theoretical solutions', floor.theoretical.length, floor.rawTheoretical, engine.theoreticalIdx.length)));
    parts.push('<h4>Suggested openers</h4>');
    parts.push(openerBlock(floor));
    parts.push('</section>');
    return parts.join('');
  }
  function renderGauntletBoard(view) {
    var board = $('gauntletBoard');
    if (!board) return;
    var active = document.activeElement;
    var activeId = active && active.id && board.contains(active) ? active.id : '';
    var selStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    var n = view.floors.length;
    var intro = n + (n === 3
      ? ' dungeons, back to back — one shared entity in every solution, in any slot. Floor 1 is a normal puzzle. Once its solution is known, later floors only list dungeons that can still share an entity with the solutions already known. Editing or clearing a solution recomputes the floors below it. Analysis and Tree follow the focused floor.'
      : ' dungeons, one shared entity in every solution. Floor 1 is a normal puzzle. Later floors narrow once earlier solutions are known. Analysis and Tree follow the focused floor.');
    board.innerHTML = '<h2>Gauntlet</h2><p class="muted small">' + esc(intro) + '</p>' +
      view.floors.map(function (floor, i) { return renderGauntletFloor(i, floor); }).join('');
    if (activeId) {
      var again = document.getElementById(activeId);
      if (again) {
        again.focus();
        if (selStart != null) { try { again.setSelectionRange(selStart, selStart); } catch (e2) {} }
      }
    }
  }
  function updateFloorPreview(i) {
    var el = $('gPreview' + i);
    var floor = gauntlet.floors[i];
    if (!el || !floor || !engine) return;
    var syms = Pack.parseWord(floor.draftGuess || '', activePack()).slice(0, cfg.L);
    while (syms.length < cfg.L) syms.push('');
    var parsed = parsePat(floor.draftPat || '');
    if (parsed) floor.previewDigits = parsed;
    if (!floor.previewDigits || floor.previewDigits.length !== cfg.L) floor.previewDigits = new Array(cfg.L).fill(0);
    el.innerHTML = tilesHTML(syms, floor.previewDigits, { interactive: true });
  }
  function cycleFloorTile(i, tileIndex) {
    var floor = gauntlet.floors[i];
    if (!floor || !engine) return;
    if (!floor.previewDigits || floor.previewDigits.length !== cfg.L) floor.previewDigits = new Array(cfg.L).fill(0);
    var marks = engine.pack.clueAlphabet || [{ value: 0 }, { value: 1 }, { value: 2 }];
    var cur = floor.previewDigits[tileIndex] || 0, k, at = 0;
    for (k = 0; k < marks.length; k++) if (marks[k].value === cur) at = k;
    floor.previewDigits[tileIndex] = marks[(at + 1) % marks.length].value;
    floor.draftPat = patCode(floor.previewDigits).replace(/⬛/g, 'b').replace(/🟨/g, 'y').replace(/🟩/g, 'g');
    var pat = $('gPat' + i);
    if (pat) pat.value = floor.draftPat;
    updateFloorPreview(i);
  }
  function submitFloor(i) {
    var floor = gauntlet.floors[i];
    if (!floor || !engine) return;
    var guessEl = $('gGuess' + i);
    var patEl = $('gPat' + i);
    var raw = guessEl ? guessEl.value : (floor.draftGuess || '');
    var pat = patEl ? patEl.value : (floor.draftPat || '');
    var digits = parsePat(pat) || (!String(pat || '').trim() && floor.previewDigits && floor.previewDigits.length === cfg.L ? floor.previewDigits.slice() : null);
    var g = engine.encode(raw);
    if (g.err) { alert('Guess ' + g.err); return; }
    if (!digits) { alert('Result must be ' + cfg.L + ' codes, e.g. ' + 'bgybb'.slice(0, cfg.L)); return; }
    var made = engine.makeClue(g.key, digits);
    floor.clues.push({ key: made.key, ids: made.ids, syms: made.syms, digits: made.digits, pat: made.pat, word: made.word, clue: made.clue, note: validityNote(made.key) });
    floor.draftGuess = '';
    floor.draftPat = '';
    floor.previewDigits = null;
    if (i === gauntlet.focus) {
      bdFilterPat = null;
      if ($('bdFilter')) $('bdFilter').value = '';
    }
    refresh();
    var again = $('gGuess' + i);
    if (again) again.focus();
  }
  function onSolutionInput(i, value) {
    var floor = gauntlet.floors[i];
    if (!floor) return;
    var prev = floor.solution || '';
    floor.solution = value;
    var prevPin = pinnedKey(prev);
    var nextPin = pinnedKey(value);
    var prevEmpty = !String(prev).trim();
    var nextEmpty = !String(value).trim();
    if (prevPin !== nextPin || prevEmpty !== nextEmpty) {
      refresh();
      return;
    }
    var note = $('gSolNote' + i);
    if (note) note.textContent = nextEmpty ? '' : ('Enter ' + cfg.L + ' tokens. Later floors update when the solution is complete.');
  }
  function fillGauntletList(box) {
    if (!gauntletView || !box || box.dataset.filled === '1') return;
    var floor = gauntletView.floors[+box.getAttribute('data-floor')];
    if (!floor) return;
    var idxs = box.getAttribute('data-which') === 'theoretical' ? floor.theoretical : floor.known;
    box.classList.toggle('art', showImages() && idxs.length <= 400);
    box.innerHTML = listHTML(idxs);
    box.dataset.filled = '1';
  }
  function onGauntletClick(e) {
    var tile = e.target.closest && e.target.closest('.gauntlet-preview .tile');
    if (tile) {
      var host = tile.closest('.gauntlet-preview');
      if (host) cycleFloorTile(+host.getAttribute('data-floor'), +tile.dataset.i);
      return;
    }
    var focusBtn = e.target.closest && e.target.closest('[data-focus]');
    if (focusBtn) {
      gauntlet.focus = +focusBtn.getAttribute('data-focus');
      syncGauntletMode();
      refresh();
      return;
    }
    var add = e.target.closest && e.target.closest('[data-add]');
    if (add) { submitFloor(+add.getAttribute('data-add')); return; }
    var undo = e.target.closest && e.target.closest('[data-undo]');
    if (undo) {
      var u = gauntlet.floors[+undo.getAttribute('data-undo')];
      if (u) u.clues.pop();
      refresh();
      return;
    }
    var clearClues = e.target.closest && e.target.closest('[data-clear-clues]');
    if (clearClues) {
      var cf = gauntlet.floors[+clearClues.getAttribute('data-clear-clues')];
      if (cf) cf.clues.splice(0, cf.clues.length);
      refresh();
      return;
    }
    var clearSol = e.target.closest && e.target.closest('[data-clear-solution]');
    if (clearSol) {
      var sf = gauntlet.floors[+clearSol.getAttribute('data-clear-solution')];
      if (sf) sf.solution = '';
      refresh();
      return;
    }
    var del = e.target.closest && e.target.closest('[data-del]');
    if (del) {
      var card = del.closest('[data-floor]');
      var df = card && gauntlet.floors[+card.getAttribute('data-floor')];
      if (df) df.clues.splice(+del.getAttribute('data-del'), 1);
      refresh();
      return;
    }
    var pick = e.target.closest && e.target.closest('tr[data-pick]');
    if (pick) {
      var section = pick.closest('[data-floor]');
      var pi = section ? +section.getAttribute('data-floor') : -1;
      var pf = gauntlet.floors[pi];
      if (!pf) return;
      pf.draftGuess = pick.getAttribute('data-pick') || '';
      pf.draftPat = '';
      pf.previewDigits = new Array(cfg.L).fill(0);
      var input = $('gGuess' + pi);
      if (input) { input.value = pf.draftGuess; input.focus(); }
      keyTarget = input || keyTarget;
      updateFloorPreview(pi);
      markKeyTarget();
    }
  }
  function onGauntletInput(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var kind = t.getAttribute('data-gauntlet-field');
    if (!kind) return;
    var i = +t.getAttribute('data-floor');
    var floor = gauntlet.floors[i];
    if (!floor) return;
    if (kind === 'guess') { floor.draftGuess = t.value; updateFloorPreview(i); }
    else if (kind === 'pat') { floor.draftPat = t.value; updateFloorPreview(i); }
    else if (kind === 'solution') onSolutionInput(i, t.value);
  }
  function onGauntletKey(e) {
    if (e.key !== 'Enter') return;
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var kind = t.getAttribute('data-gauntlet-field');
    if (!kind || kind === 'solution') return;
    var i = +t.getAttribute('data-floor');
    if (kind === 'guess') {
      var pat = $('gPat' + i);
      if (pat && !pat.value) { pat.focus(); e.preventDefault(); return; }
    }
    e.preventDefault();
    submitFloor(i);
  }
  function bindGauntletBoard() {
    var board = $('gauntletBoard');
    if (!board || board.dataset.bound) return;
    board.dataset.bound = '1';
    board.addEventListener('click', onGauntletClick);
    board.addEventListener('input', onGauntletInput);
    board.addEventListener('keydown', onGauntletKey);
    board.addEventListener('toggle', function (ev) {
      var d = ev.target;
      if (!d || !d.classList || !d.classList.contains('gauntlet-list') || !d.open) return;
      var box = d.querySelector('.wordlist');
      if (box) fillGauntletList(box);
    }, true);
    board.addEventListener('focusin', function (ev) {
      var t = ev.target;
      if (t && t.getAttribute && t.getAttribute('data-gauntlet-field')) {
        keyTarget = t;
        markKeyTarget();
      }
    });
  }

  function refresh() {
    if (!engine) return;
    syncGauntletMode();
    var view = null;
    if (gauntletActive()) {
      view = buildGauntletView();
      var focusFloor = view.floors[gauntlet.focus] || view.floors[0];
      remKnown = focusFloor.known;
      remTheo = focusFloor.theoretical;
      remaining = focusFloor.active;
    } else {
      var parts = engine.replay(clues, cfg.layer);
      remKnown = parts.known;
      remTheo = parts.theoretical;
      remaining = engine.activeRemaining(cfg.layer, parts);
    }
    gauntletView = view;
    if (!cfg.stepsTouched) {
      cfg.steps = Math.max(1, 6 - clues.length);
      if ($('cfgSteps')) $('cfgSteps').value = cfg.steps;
      if ($('treeBudget')) $('treeBudget').value = cfg.steps;
    }
    renderClues(); renderRemaining(); renderPreview(); renderKeyboard();
    selectedKey = null; autoSel = true;
    $('bdRows').innerHTML = ''; $('bdSummary').textContent = ''; $('bdTitle').textContent = '';
    $('bdGuess').value = ''; delete $('bdRows').dataset.guess;
    syncGauntletChrome();
    if (view) renderGauntletBoard(view);
    else if ($('gauntletBoard')) $('gauntletBoard').innerHTML = '';
    scheduleScore();
    refreshOpeners();
    saveState();
  }

  // ---------- packs ----------
  function savedPacks() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } }
  function jsonPacks() { try { return JSON.parse(localStorage.getItem(LS_JSON) || '{}'); } catch (e) { return {}; } }
  function fillPackSel() {
    var sp = savedPacks(), jp = jsonPacks(), sel = $('packSel');
    sel.innerHTML = BUILTIN.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('') +
      Object.keys(jp).map(function (k) {
        var rec = jp[k] || {};
        return '<option value="json:' + esc(k) + '">◆ ' + esc(rec.name || k) + '</option>';
      }).join('') +
      Object.keys(sp).map(function (k) { return '<option value="saved:' + esc(k) + '">★ ' + esc(k) + '</option>'; }).join('');
    sel.value = packId;
    syncNytPanel();
  }
  function readCfgFromUI() {
    cfg.L = Math.max(1, Math.min(20, parseInt($('cfgL').value, 10) || 5));
    cfg.alpha = $('cfgAlpha').value; cfg.ci = $('cfgCI').checked; cfg.tok = $('cfgTok').checked;
    cfg.rule = $('cfgRule').value; cfg.valid = $('cfgValid').value;
  }
  function writeCfgToUI() {
    $('cfgL').value = cfg.L; $('cfgAlpha').value = cfg.alpha; $('cfgCI').checked = cfg.ci; $('cfgTok').checked = cfg.tok;
    $('cfgRule').value = cfg.rule; $('cfgValid').value = cfg.valid; $('cfgMode').value = cfg.mode; $('cfgHard').value = cfg.hard;
    $('cfgAnsOnly').checked = cfg.ansOnly; $('cfgMax').value = cfg.max; $('cfgTop').value = cfg.top; $('cfgNotation').value = cfg.notation;
    $('cfgGuarantee').checked = !!cfg.guarantee; $('cfgSteps').value = cfg.steps || 6;
    if ($('treeBudget')) $('treeBudget').value = cfg.steps || 6;
    if ($('treePolicy')) $('treePolicy').value = cfg.treePolicy || 'worst';
    mirrorTreeRules();
    $('cfgLayer').value = cfg.layer || 'known';
    $('cfgGuessMode').value = cfg.guessMode || inferGuessMode();
    if ($('cfgImages')) $('cfgImages').checked = cfg.images !== false;
    if ($('cfgCake')) $('cfgCake').checked = !!cfg.cake;
    applyPage(cfg.page || 'both', true);
    syncCakeOption();
  }
  function reportPack(keepClues) {
    if (keepPackWarn) keepPackWarn = false;
    else setPackWarn('');
    var extraGuesses = 0, fi;
    for (fi = 0; fi < engine.flags.length; fi++) if (engine.flags[fi].guess && !engine.flags[fi].known) extraGuesses++;
    var msg;
    if (engine.pack.listSource) {
      msg = remoteStatus(engine);
      if (engine.rej) msg += ' · ' + engine.rej + ' entries skipped (wrong length/alphabet)';
    } else {
      msg = engine.nKnown.toLocaleString() + ' answers, ' + extraGuesses.toLocaleString() + ' extra guesses';
      if (engine.pack.lists && engine.pack.lists.theoretical === 'generated') {
        msg += ' · ' + engine.theoreticalIdx.length.toLocaleString() + ' theoretical';
      }
      if (engine.ruleDrift && engine.ruleDrift.length) {
        msg += ' · ' + engine.ruleDrift.length + ' known answers outside the generated rules (' +
          engine.ruleDrift.slice(0, 8).join(', ') + (engine.ruleDrift.length > 8 ? ', …' : '') + ')';
      }
      if (engine.rej) msg += ' · ' + engine.rej + ' entries skipped (wrong length/alphabet)';
      if (engine.dup) msg += ' · ' + engine.dup + ' duplicates merged';
    }
    document.body.classList.toggle('case-sensitive', !!(engine.pack && engine.pack.caseInsensitive === false));
    if ($('imagesToggleLabel')) $('imagesToggleLabel').hidden = !(engine.pack && engine.pack.appearance);
    if ($('cfgImages')) $('cfgImages').checked = cfg.images !== false;
    syncCakeOption();
    $('packMsg').textContent = msg;
    var summary = ($('packSel').selectedOptions[0] || {}).textContent + ' · ' + engine.nKnown.toLocaleString() + ' answers';
    if (engine.pack.listSource) summary += ' · ' + engine.guessIdx.length.toLocaleString() + ' guesses';
    $('packSummary').textContent = summary;
    dropTree();
    cfg.L = engine.pack.length;
    ensureGauntletFloors(gauntletFloors());
    if (!keepClues) {
      gauntlet.floors.forEach(function (f) {
        f.clues.splice(0, f.clues.length);
        f.solution = '';
        f.draftGuess = '';
        f.draftPat = '';
        f.previewDigits = null;
      });
      gauntlet.focus = 0;
      clues = gauntlet.floors[0].clues;
    } else {
      gauntlet.floors.forEach(function (f) { reencodeClueList(f.clues); });
    }
    $('bdGuess').value = ''; selectedKey = null;
    refresh();
    packPhase = 'ready';
    packError = '';
    readyPackId = packId;
    renderNytCounts();
    scheduleTreeFlush();
  }
  function mountCustom(keepClues) {
    packGen++;
    treeFlushToken++;
    cancelScore();
    try {
      readCfgFromUI();
      var pack = Pack.fromCustom({
        length: cfg.L, alphabet: cfg.alpha, caseInsensitive: cfg.ci, tokens: cfg.tok, rule: cfg.rule, name: 'Custom'
      });
      engine = window.SolverEngine.create(pack, { answers: $('ansText').value, guesses: $('guessText').value });
      engine.feedbackRule = cfg.rule === 'simple' ? 'simple' : 'wordle';
      reportPack(keepClues);
    } catch (err) {
      packPhase = 'failed';
      packError = TreeStatus.errorText(err);
      $('packMsg').textContent = 'Could not build this pack (' + packError + ').';
      failQueuedPack();
      throw err;
    }
  }
  function fetchManifest(url) {
    if (!manifestCache[url]) {
      manifestCache[url] = fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).catch(function (e) { delete manifestCache[url]; throw e; });
    }
    return manifestCache[url];
  }
  var manifestCache = {};
  function applyDeclaredGuessMode(declared, applyDefaults) {
    if (applyDefaults) {
      if (declared) applyGuessMode(declared);
      else if (packGuessDefault) applyGuessMode('dictionary');
    }
    packGuessDefault = declared || null;
  }
  function applyGuessMode(mode) {
    cfg.guessMode = mode;
    if (mode === 'any') { cfg.valid = 'any'; cfg.hard = 'off'; cfg.ansOnly = false; }
    else if (mode === 'hard') { cfg.valid = 'both'; cfg.hard = 'strict'; cfg.ansOnly = false; }
    else if (mode === 'answersOnly') { cfg.valid = 'both'; cfg.hard = 'off'; cfg.ansOnly = true; }
    else { cfg.valid = 'both'; cfg.hard = 'off'; cfg.ansOnly = false; cfg.guessMode = 'dictionary'; }
  }
  function setPackWarn(text) {
    packWarn = text || '';
    var el = $('packWarn');
    if (!el) return;
    el.hidden = !packWarn;
    el.textContent = packWarn;
    if (packWarn && $('setupCard')) $('setupCard').open = true;
  }
  function syncNytPanel() {
    var el = $('nytSources');
    if (el) el.hidden = packId !== 'nyt';
    if (packId !== 'nyt') renderNytCounts();
  }
  function formatChecked(unix) {
    var d = new Date((unix || 0) * 1000);
    if (!unix || isNaN(d.getTime())) return '';
    return d.toLocaleString();
  }
  function renderNytCounts() {
    var el = $('nytCounts');
    if (!el) return;
    var src = engine && engine.pack && engine.pack.listSource;
    if (!src || packId !== 'nyt') { el.textContent = ''; return; }
    var when = src.lastChecked ? (' Last checked ' + formatChecked(src.lastChecked) + '.') : '';
    el.textContent = 'Loaded ' + src.answerCount.toLocaleString() + ' answers from ' + src.answers.file +
      ' and ' + src.guessCount.toLocaleString() + ' guesses from ' + src.guesses.file + '. ' +
      (src.originNote || '') + when;
  }
  function remoteStatus(eng) {
    var src = eng.pack.listSource;
    var where = 'Saved on this host';
    if (src.origin === 'github-direct') where = 'Direct from WordGamesBot';
    else if (src.stale) where = 'Last good copy on this host';
    else if (src.origin === 'github') where = 'Fetched by this host';
    return where + ' · ' + src.answers.label + ': ' + eng.nKnown.toLocaleString() +
      ' answers · ' + src.guesses.label + ': ' + eng.guessIdx.length.toLocaleString() + ' valid guesses';
  }
  function packLabel(id) {
    var i;
    if (!id) return 'the ENABLE 5-letter pack';
    if (id.indexOf('saved:') === 0) return 'the saved pack ' + id.slice(6);
    if (id.indexOf('json:') === 0) return 'the custom pack ' + (jsonPacks()[id.slice(5)] && jsonPacks()[id.slice(5)].name || id.slice(5));
    for (i = 0; i < BUILTIN.length; i++) if (BUILTIN[i].id === id) return BUILTIN[i].name;
    return 'the previous pack';
  }
  function remoteErrorText(err) {
    var msg = (err && err.message) ? err.message : String(err || 'the lists could not be fetched');
    if (msg === 'Failed to fetch' || msg === 'Load failed' || msg === 'NetworkError when attempting to fetch resource.') {
      return 'the browser could not reach GitHub (' + msg + ')';
    }
    return msg;
  }
  function pickRemote(list, id) {
    var i, fallback = null;
    if (!list || !list.length) throw new Error('Pack is missing a word list');
    for (i = 0; i < list.length; i++) if (list[i].default) fallback = list[i];
    if (!fallback) fallback = list[0];
    for (i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return fallback;
  }
  function fillNytSelects(manifest) {
    if (!$('nytAnswers') || !manifest || !manifest.remote) return;
    nytFilling = true;
    function fill(sel, list, chosen) {
      sel.innerHTML = list.map(function (item) {
        return '<option value="' + esc(item.id) + '">' + esc(item.label) + '</option>';
      }).join('');
      sel.value = chosen;
    }
    fill($('nytAnswers'), manifest.remote.answers, nytWant.answers);
    fill($('nytGuesses'), manifest.remote.guesses, nytWant.guesses);
    nytFilling = false;
  }
  function fetchRemoteText(url, timeoutMs) {
    var ms = timeoutMs || 12000;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var opts = { cache: 'no-cache' };
    if (ctrl) opts.signal = ctrl.signal;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;
      function cleanup() { if (timer) clearTimeout(timer); }
      function ok(v) { if (settled) return; settled = true; cleanup(); resolve(v); }
      function bad(e) { if (settled) return; settled = true; cleanup(); reject(e); }
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        else bad(new Error('timed out after ' + Math.round(ms / 1000) + 's'));
      }, ms);
      fetch(url, opts).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(ok).catch(function (e) {
        if (e && e.name === 'AbortError') bad(new Error('timed out after ' + Math.round(ms / 1000) + 's'));
        else bad(e);
      });
    });
  }
  function fetchRemoteList(spec, length, timeoutMs, skipMemory) {
    var cached = nytCache[spec.url];
    if (!skipMemory && cached) return Promise.resolve(cached);
    return fetchRemoteText(spec.url, timeoutMs).then(function (text) {
      var parsed = window.SolverListParse.parseConstArray(text, {
        length: length,
        minCount: spec.minCount,
        maxCount: spec.maxCount,
        caseInsensitive: true
      });
      if (!parsed.ok) throw new Error(spec.file + ': ' + parsed.error);
      var rec = { words: parsed.words, count: parsed.count, url: spec.url };
      nytCache[spec.url] = rec;
      return rec;
    }).catch(function (e) {
      var msg = (e && e.message) ? e.message : 'could not be fetched';
      if (msg.indexOf(spec.file) === 0) throw e;
      throw new Error(spec.file + ': ' + msg);
    });
  }
  function mountFetchedPack(pack, manifest, variant, builtin, answersText, guessesText, rules, keepClues, applyDefaults) {
    cfg.L = pack.length; cfg.tok = pack.delimiter !== 'none'; cfg.ci = pack.caseInsensitive;
    cfg.alpha = typeof manifest.alphabet === 'string' ? manifest.alphabet : cfg.alpha;
    cfg.rule = pack.feedback === 'simple' ? 'simple' : 'wordle';
    applyDeclaredGuessMode((variant && variant.guessMode) || manifest.guessMode || (builtin && builtin.guessMode) || null, applyDefaults);
    writeCfgToUI();
    $('ansText').value = String(answersText || '').trim();
    $('guessText').value = String(guessesText || '').trim();
    pack.rulesImpl = rules;
    engine = window.SolverEngine.create(pack, {
      answers: answersText || '',
      guesses: guessesText || '',
      options: { cake: !!cfg.cake }
    });
    reportPack(keepClues);
  }
  function cakePackActive() {
    return !!(engine && engine.pack && engine.pack.id === 'dungleon');
  }
  function syncCakeOption() {
    var el = $('cakeOption');
    if (!el) return;
    el.hidden = !cakePackActive();
    if ($('cfgCake')) $('cfgCake').checked = !!cfg.cake;
  }
  function remountActivePack() {
    if (!engine || !engine.pack || !engine.pack.rulesImpl) return;
    cancelScore();
    gauntletOpenerCache.gen = -1;
    gauntletOpenerCache.map = Object.create(null);
    var pack = engine.pack;
    engine = window.SolverEngine.create(pack, {
      answers: $('ansText').value,
      guesses: $('guessText').value,
      options: { cake: !!cfg.cake }
    });
    reportPack(true);
  }
  function failRemotePack(err, previousReady) {
    var why = remoteErrorText(err);
    var Parse = window.SolverListParse;
    var plan = (Parse && Parse.choosePackFallback) ? Parse.choosePackFallback({
      haveReady: !!(engine && previousReady),
      previousId: previousReady,
      requestedId: 'nyt',
      fallbackId: 'en5'
    }) : ((engine && previousReady) ? { action: 'keep', packId: previousReady } : { action: 'load', packId: 'en5' });
    packError = why;
    failQueuedPack();
    packError = '';
    if (plan.action === 'keep') {
      var stayedLive = plan.packId === 'nyt' && engine && engine.pack && engine.pack.listSource;
      if (stayedLive && nytLoaded) {
        nytWant.answers = nytLoaded.answers;
        nytWant.guesses = nytLoaded.guesses;
        cfg.nytAnswers = nytLoaded.answers;
        cfg.nytGuesses = nytLoaded.guesses;
        if ($('nytAnswers')) $('nytAnswers').value = nytLoaded.answers;
        if ($('nytGuesses')) $('nytGuesses').value = nytLoaded.guesses;
        var src = engine.pack.listSource;
        setPackWarn('Could not switch WordleBot lists (' + why + '). Still using ' +
          src.answers.label + ' (' + engine.nKnown.toLocaleString() + ' answers) and ' +
          src.guesses.label + ' (' + engine.guessIdx.length.toLocaleString() + ' guesses).');
        $('packMsg').textContent = remoteStatus(engine);
      } else {
        packId = plan.packId;
        fillPackSel();
        setPackWarn('Could not load the WordleBot lists (' + why + '). Staying on ' + packLabel(plan.packId) + '.');
        $('packMsg').textContent = 'WordleBot lists did not load. This pack is unchanged.';
      }
      packPhase = 'ready';
      scheduleScore();
      saveState();
      return Promise.resolve();
    }
    setPackWarn('Could not load the WordleBot lists (' + why + '). Showing ' + packLabel(plan.packId) + ' instead.');
    keepPackWarn = true;
    packId = plan.packId;
    fillPackSel();
    return loadPack(plan.packId, false);
  }
  function markAbsent(err) {
    if (err && err.endpointAbsent) return err;
    var absent = new Error('endpoint-absent');
    absent.endpointAbsent = true;
    return absent;
  }
  function fetchServerLists(asked) {
    var url = 'api/wordlebot.php' + (asked ? '?refresh=1' : '');
    return fetchRemoteText(url, 60000).then(function (text) {
      var trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
      var data = null;
      if (trimmed.charAt(0) === '{') {
        try { data = JSON.parse(trimmed); } catch (e) { data = null; }
      }
      if (!data || typeof data !== 'object') throw markAbsent();
      return data;
    }).catch(function (err) {
      if (err && err.endpointAbsent) throw err;
      var msg = err && err.message ? err.message : '';
      if (msg === 'HTTP 404' || msg === 'HTTP 405' || msg === 'Failed to fetch' || msg === 'Load failed' || (err && err.name === 'TypeError')) {
        throw markAbsent();
      }
      throw err;
    });
  }
  function validServerList(entry, spec) {
    var words, i, w, min, max;
    if (!entry || !entry.words || !entry.words.length) return false;
    words = entry.words;
    min = spec.minCount || 1;
    max = spec.maxCount || 0;
    if (words.length < min) return false;
    if (max && words.length > max) return false;
    for (i = 0; i < words.length; i++) {
      w = words[i];
      if (typeof w !== 'string' || !/^[a-z]{5}$/.test(w)) return false;
    }
    return true;
  }
  function originNote(meta) {
    if (!meta) return '';
    if (meta.origin === 'github-direct') {
      if (meta.refresh === 'not-due') return 'Loaded directly from WordGamesBot. This preview has no host cache, so Check now does not fetch again.';
      return 'Loaded directly from WordGamesBot because this host has no solver cache.';
    }
    if (meta.stale || meta.refresh === 'failed' || meta.refresh === 'cooldown') {
      return 'This host is serving its last good copy. The latest check did not reach WordGamesBot.' +
        (meta.error ? (' ' + meta.error + '.') : '');
    }
    if (meta.origin === 'github' || meta.refresh === 'fetched') return 'This host fetched the lists from WordGamesBot.';
    if (meta.refresh === 'not-due') return 'This host’s saved copy is under 24 hours old, so WordGamesBot was not contacted.';
    return 'This host’s saved copy.';
  }
  function listsFromServer(data, ans, gue) {
    var a, g;
    if (!data || data.ok === false || !data.lists) {
      throw new Error((data && data.error) ? data.error : 'solver cache has no lists');
    }
    a = data.lists[ans.id];
    g = data.lists[gue.id];
    if (!validServerList(a, ans) || !validServerList(g, gue)) throw new Error('solver cache failed the list check');
    return {
      answers: { words: a.words, count: a.words.length },
      guesses: { words: g.words, count: g.words.length },
      meta: data
    };
  }
  function payloadCovers(data, ans, gue) {
    return !!(data && data.ok !== false && data.lists &&
      validServerList(data.lists[ans.id], ans) && validServerList(data.lists[gue.id], gue));
  }
  function loadWordlebotPair(ans, gue, length, timeoutMs, asked) {
    var directHeld = nytServerPayload && nytServerPayload.origin === 'github-direct' && payloadCovers(nytServerPayload, ans, gue);
    if (directHeld) {
      var held = asked ? Object.assign({}, nytServerPayload, { refresh: 'not-due' }) : nytServerPayload;
      return Promise.resolve(listsFromServer(held, ans, gue));
    }
    if (!asked && payloadCovers(nytServerPayload, ans, gue)) {
      return Promise.resolve(listsFromServer(nytServerPayload, ans, gue));
    }
    return fetchServerLists(asked).then(function (data) {
      var pair = listsFromServer(data, ans, gue);
      nytServerPayload = data;
      return pair;
    }).catch(function (err) {
      if (!err || !err.endpointAbsent) throw err;
      return Promise.all([
        fetchRemoteList(ans, length, timeoutMs, asked),
        fetchRemoteList(gue, length, timeoutMs, asked)
      ]).then(function (parts) {
        var meta = (nytServerPayload && nytServerPayload.origin === 'github-direct') ? nytServerPayload : {
          ok: true,
          origin: 'github-direct',
          stale: false,
          error: null,
          lists: {}
        };
        meta.refresh = 'fetched';
        meta.lastChecked = Math.floor(Date.now() / 1000);
        meta.error = null;
        meta.stale = false;
        meta.lists[ans.id] = { words: parts[0].words, count: parts[0].count };
        meta.lists[gue.id] = { words: parts[1].words, count: parts[1].count };
        nytServerPayload = meta;
        return { answers: parts[0], guesses: parts[1], meta: meta };
      });
    });
  }
  function fetchAndMountNyt(gen, keepClues, applyDefaults, builtin) {
    function current() { return gen === packGen; }
    if (!window.SolverListParse) return Promise.reject(new Error('Word list parser failed to load'));
    return fetchManifest(builtin.manifest).then(function (manifest) {
      if (!current()) return;
      if (!manifest.remote || !manifest.remote.answers || !manifest.remote.guesses) {
        throw new Error('Pack has no remote lists');
      }
      var variant = null;
      (manifest.variants || []).forEach(function (v) { if (v.id === builtin.variant) variant = v; });
      if (!variant) throw new Error('missing variant ' + builtin.variant);
      var pack = Pack.normalize(manifest, variant);
      var ans = pickRemote(manifest.remote.answers, nytWant.answers || cfg.nytAnswers);
      var gue = pickRemote(manifest.remote.guesses, nytWant.guesses || cfg.nytGuesses);
      nytWant.answers = ans.id;
      nytWant.guesses = gue.id;
      cfg.nytAnswers = ans.id;
      cfg.nytGuesses = gue.id;
      fillNytSelects(manifest);
      var timeoutMs = manifest.remote.timeoutMs || 12000;
      var asked = nytCheckNow;
      nytCheckNow = false;
      return Promise.all([
        loadWordlebotPair(ans, gue, pack.length, timeoutMs, asked),
        Pack.loadRules(pack, function (rel) {
          return fetch('packs/' + rel).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.text();
          });
        })
      ]).then(function (parts) {
        if (!current()) return;
        var pair = parts[0];
        var meta = pair.meta || {};
        pack.listSource = {
          repo: manifest.remote.repo,
          answers: ans,
          guesses: gue,
          answerCount: pair.answers.count,
          guessCount: pair.guesses.count,
          origin: meta.origin || '',
          stale: !!meta.stale,
          refresh: meta.refresh || '',
          lastChecked: meta.lastChecked || null,
          error: meta.error || '',
          originNote: originNote(meta)
        };
        nytLoaded = { answers: ans.id, guesses: gue.id };
        mountFetchedPack(pack, manifest, variant, builtin, pair.answers.words.join('\n'), pair.guesses.words.join('\n'), parts[1], keepClues, applyDefaults);
      });
    });
  }
  function onNytChoice() {
    if (nytFilling || packId !== 'nyt') return;
    var answers = $('nytAnswers').value || nytWant.answers;
    var guesses = $('nytGuesses').value || nytWant.guesses;
    var src = engine && engine.pack && engine.pack.listSource;
    if (src && src.answers.id === answers && src.guesses.id === guesses) return;
    nytWant.answers = answers;
    nytWant.guesses = guesses;
    cfg.nytAnswers = answers;
    cfg.nytGuesses = guesses;
    loadPack('nyt', true, false);
  }
  function loadPack(id, keepClues, applyDefaults) {
    var gen = ++packGen;
    var previousReady = readyPackId;
    treeFlushToken++;
    cancelScore();
    packPhase = 'loading';
    packId = id;
    syncNytPanel();
    function current() { return gen === packGen; }
    if (id.indexOf('saved:') === 0) {
      var p = savedPacks()[id.slice(6)];
      if (!p) {
        packPhase = 'failed';
        packError = 'Saved pack is missing';
        failQueuedPack();
        return Promise.resolve();
      }
      Object.assign(cfg, p.cfg || {});
      cfg.guessMode = inferGuessMode();
      writeCfgToUI();
      $('ansText').value = p.answers || ''; $('guessText').value = p.guesses || '';
      mountCustom(keepClues); return Promise.resolve();
    }
    if (id.indexOf('json:') === 0) {
      return loadJsonPack(id.slice(5), gen, !!keepClues, !!applyDefaults);
    }
    var b = BUILTIN.filter(function (x) { return x.id === id; })[0];
    if (!b) b = BUILTIN.filter(function (x) { return x.id === 'en5'; })[0] || BUILTIN[0];
    if (b.blank) {
      cfg.tok = false; cfg.ci = true; cfg.alpha = 'abcdefghijklmnopqrstuvwxyz';
      if (b.preset) Object.assign(cfg, b.preset);
      writeCfgToUI(); $('ansText').value = ''; $('guessText').value = '';
      $('setupCard').open = true; mountCustom(false); return Promise.resolve();
    }
    if (b.remote) {
      $('packMsg').textContent = 'Loading WordleBot lists…';
      return fetchAndMountNyt(gen, !!keepClues, !!applyDefaults, b).catch(function (e) {
        if (!current()) return;
        return failRemotePack(e, previousReady);
      });
    }
    $('packMsg').textContent = 'Loading…';
    return fetchManifest(b.manifest || 'packs/wordle-en.json').then(function (manifest) {
      if (!current()) return;
      var variant = null;
      (manifest.variants || []).forEach(function (v) { if (v.id === b.variant) variant = v; });
      if (!variant) throw new Error('missing variant ' + b.variant);
      var pack = Pack.normalize(manifest, variant);
      function fetchPack(rel) {
        return fetch('packs/' + rel).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
      }
      return Promise.all([
        fetchPack(variant.knownSolutions),
        variant.guessList ? fetchPack(variant.guessList) : Promise.resolve(''),
        Pack.loadRules(pack, fetchPack)
      ]).then(function (t) {
        if (!current()) return;
        mountFetchedPack(pack, manifest, variant, b, t[0], t[1] || '', t[2], keepClues, applyDefaults);
      });
    }).catch(function (e) {
      if (!current()) return;
      keepPackWarn = false;
      packPhase = 'failed';
      packError = (e && e.message) ? e.message : String(e || 'load failed');
      $('packMsg').textContent = 'Could not load built-in pack (' + packError + '). Paste or upload lists instead.';
      $('setupCard').open = true;
      failQueuedPack();
    });
  }
  $('packSel').addEventListener('change', function () { loadPack($('packSel').value, false, true); });
  if ($('nytAnswers')) $('nytAnswers').addEventListener('change', onNytChoice);
  if ($('nytGuesses')) $('nytGuesses').addEventListener('change', onNytChoice);
  if ($('nytCheck')) $('nytCheck').addEventListener('click', function () {
    if (packId !== 'nyt') return;
    nytCheckNow = true;
    loadPack('nyt', true, false);
  });
  $('applyBtn').addEventListener('click', function () { mountCustom(true); });
  $('savePackBtn').addEventListener('click', function () {
    var name = prompt('Name for this pack (saved in this browser only):', ''); if (!name) return;
    readCfgFromUI();
    var sp = savedPacks();
    sp[name] = { answers: $('ansText').value, guesses: $('guessText').value, cfg: { L: cfg.L, alpha: cfg.alpha, ci: cfg.ci, tok: cfg.tok, rule: cfg.rule, valid: cfg.valid } };
    try { localStorage.setItem(LS_KEY, JSON.stringify(sp)); } catch (e) { alert('Could not save (storage full?)'); return; }
    packId = 'saved:' + name; fillPackSel(); mountCustom(true);
  });
  $('delPackBtn').addEventListener('click', function () {
    if (packId.indexOf('json:') === 0) {
      deleteJsonPack(packId.slice(5));
      packId = 'nyt'; fillPackSel(); loadPack('nyt', false);
      return;
    }
    if (packId.indexOf('saved:') !== 0) { alert('Select a saved (★ or ◆) pack first.'); return; }
    var sp = savedPacks(); delete sp[packId.slice(6)]; localStorage.setItem(LS_KEY, JSON.stringify(sp));
    packId = 'nyt'; fillPackSel(); loadPack('nyt', false);
  });
  function wireFile(inputId, areaId) {
    $(inputId).addEventListener('change', function () {
      var f = this.files[0]; if (!f) return;
      f.text().then(function (t) { $(areaId).value = t.trim(); packId = 'blank'; $('packSel').value = 'blank'; mountCustom(false); });
      this.value = '';
    });
  }
  wireFile('ansFile', 'ansText'); wireFile('guessFile', 'guessText');

  function syncGuessModeLabel() {
    cfg.guessMode = inferGuessMode();
    $('cfgGuessMode').value = cfg.guessMode;
  }
  [['cfgMode', 'mode'], ['cfgNotation', 'notation']].forEach(function (p) {
    $(p[0]).addEventListener('change', function () {
      cfg[p[1]] = this.value;
      renderClues();
      if (p[0] === 'cfgNotation') { renderPreview(); renderSuggestions(lastTop); if ($('bdRows').dataset.guess) analyze($('bdRows').dataset.guess, false); }
      else scheduleScore();
      saveState();
    });
  });
  function mirrorTreeRules() {
    if ($('treeHard')) $('treeHard').value = cfg.hard;
    if ($('treeGuessMode')) $('treeGuessMode').value = cfg.guessMode || 'dictionary';
    if ($('treeLayer')) $('treeLayer').value = cfg.layer || 'known';
  }
  $('cfgHard').addEventListener('change', function () {
    cfg.hard = this.value; syncGuessModeLabel(); mirrorTreeRules(); renderClues(); scheduleScore(); saveState();
  });
  $('cfgAnsOnly').addEventListener('change', function () { cfg.ansOnly = this.checked; syncGuessModeLabel(); mirrorTreeRules(); scheduleScore(); saveState(); });
  $('cfgMax').addEventListener('change', function () { cfg.max = Math.max(10, parseInt(this.value, 10) || 12000); scheduleScore(); saveState(); });
  $('cfgTop').addEventListener('change', function () { cfg.top = Math.max(1, Math.min(500, parseInt(this.value, 10) || 15)); scheduleScore(); saveState(); });
  $('cfgGuarantee').addEventListener('change', function () { cfg.guarantee = this.checked; scheduleScore(); saveState(); });
  $('cfgSteps').addEventListener('change', function () {
    cfg.stepsTouched = true;
    cfg.steps = Math.max(1, Math.min(30, parseInt(this.value, 10) || 1));
    this.value = cfg.steps;
    if ($('treeBudget')) $('treeBudget').value = cfg.steps;
    scheduleScore();
    saveState();
  });
  $('cfgValid').addEventListener('change', function () {
    cfg.valid = this.value; syncGuessModeLabel(); mirrorTreeRules();
    clues.forEach(function (c) { c.note = validityNote(c.key); });
    renderClues(); scheduleScore(); saveState();
  });
  $('cfgRule').addEventListener('change', function () {
    cfg.rule = this.value;
    if (engine) engine.feedbackRule = this.value === 'simple' ? 'simple' : 'wordle';
    refresh();
  });
  $('cfgLayer').addEventListener('change', function () { cfg.layer = this.value; mirrorTreeRules(); refresh(); });
  $('cfgGuessMode').addEventListener('change', function () {
    var mode = this.value;
    cfg.guessMode = mode;
    if (mode === 'any') { cfg.valid = 'any'; cfg.hard = 'off'; cfg.ansOnly = false; }
    else if (mode === 'hard') { cfg.valid = 'both'; cfg.hard = 'strict'; cfg.ansOnly = false; }
    else if (mode === 'answersOnly') { cfg.valid = 'both'; cfg.hard = 'off'; cfg.ansOnly = true; }
    else { cfg.valid = 'both'; cfg.hard = 'off'; cfg.ansOnly = false; cfg.guessMode = 'dictionary'; }
    $('cfgValid').value = cfg.valid; $('cfgHard').value = cfg.hard; $('cfgAnsOnly').checked = cfg.ansOnly;
    mirrorTreeRules();
    clues.forEach(function (c) { c.note = validityNote(c.key); });
    renderClues(); scheduleScore(); saveState();
  });
  $('treeHard').addEventListener('change', function () {
    $('cfgHard').value = this.value;
    $('cfgHard').dispatchEvent(new Event('change'));
  });
  $('treeGuessMode').addEventListener('change', function () {
    $('cfgGuessMode').value = this.value;
    $('cfgGuessMode').dispatchEvent(new Event('change'));
  });
  $('treeLayer').addEventListener('change', function () {
    $('cfgLayer').value = this.value;
    $('cfgLayer').dispatchEvent(new Event('change'));
  });

  function applyPage(page, silent) {
    cfg.page = page || 'both';
    document.body.setAttribute('data-page', cfg.page);
    Array.prototype.forEach.call(document.querySelectorAll('#pageModes button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-page') === cfg.page);
    });
    if (cfg.page === 'create') openCreate();
    if (!silent) {
      saveState();
      if (cfg.page !== 'tree' && cfg.page !== 'create') scheduleScore();
    }
  }
  $('pageModes').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-page]'); if (!b) return;
    applyPage(b.getAttribute('data-page'));
  });

  function treeWord(gi) {
    if (gi == null || gi < 0 || !engine || !engine.keys[gi]) return ($('treeOpener').value || '').trim();
    return engine.keys[gi];
  }
  function treeSyms(gi) {
    if (gi == null || gi < 0 || !engine || !engine.tokens[gi]) return Pack.parseWord($('treeOpener').value || '', activePack());
    return engine.tokens[gi];
  }
  function treeGuessIdx() {
    if (cfg.valid === 'answers' && cfg.guessMode !== 'any' && cfg.guessMode !== 'hard' && cfg.guessMode !== 'answersOnly') {
      return engine.knownIdx;
    }
    return engine.guessIdx;
  }
  function currentTreeSig() {
    var clueSig = clues.map(function (c) { return c.key + ':' + c.pat; }).join(',');
    var h = 0, i;
    for (i = 0; i < remaining.length; i++) h = (h * 33 + remaining[i]) | 0;
    return [
      cfg.hard, cfg.guessMode, cfg.layer, cfg.rule, cfg.valid, cfg.steps,
      ($('treePolicy') && $('treePolicy').value) || cfg.treePolicy || 'worst',
      foldWord($('treeOpener') && $('treeOpener').value || ''),
      clueSig, remaining.length, h
    ].join('|');
  }
  function markTreeStale() {
    var el = $('treeStale');
    if (el) el.hidden = !treeResult || treeSig === currentTreeSig();
    if (scanJob && !snapStillCurrent(scanJob.snap)) {
      stopScan('Scan stopped because the settings or clues changed.');
    }
  }
  function packDeclaredOpeners() {
    return !!(engine && engine.pack && engine.pack.openers && engine.pack.openers.length);
  }
  function legalAuthoredOpeners() {
    var list = (engine.pack && engine.pack.openers) || [];
    var out = [];
    var seen = Object.create(null);
    var i, enc;
    for (i = 0; i < list.length; i++) {
      enc = engine.encode(list[i]);
      if (!enc || enc.err || !engine.keyIdx.has(enc.key) || seen[enc.key]) continue;
      seen[enc.key] = 1;
      out.push(enc.key);
    }
    return out;
  }
  // Candidates for a generated opener list. Never alphabet^length
  // (Dungleon guessMode "any" is about 20^5). Keep, in this order:
  // the pack's guess list, authored openers already in the universe,
  // then answers still in the set being solved. A pack with no guess
  // list therefore ranks remaining solutions. Past OPENER_SCORE_CELLS
  // (|candidates| × |answers|) keep a prefix so a large pool cannot hang.
  function openerCandidateIdx() {
    var seen = new Uint8Array(engine.nWords);
    var out = [];
    function add(idx) {
      idx = idx | 0;
      if (idx < 0 || idx >= engine.nWords || seen[idx]) return;
      seen[idx] = 1;
      out.push(idx);
    }
    var i, g = engine.guessIdx || [];
    for (i = 0; i < g.length; i++) add(g[i]);
    var authored = (engine.pack && engine.pack.openers) || [];
    for (i = 0; i < authored.length; i++) {
      var enc = engine.encode(authored[i]);
      if (enc && !enc.err && engine.keyIdx.has(enc.key)) add(engine.keyIdx.get(enc.key));
    }
    for (i = 0; i < remaining.length; i++) add(remaining[i]);
    var bounded = Core.boundOpenerCandidates(out, remaining.length, Core.OPENER_SCORE_CELLS);
    return { idx: bounded, capped: bounded.length < out.length };
  }
  function informationScores(indices) {
    if (!indices || !indices.length || !remaining.length) return [];
    return Core.rankByInformation({
      U: engine.U,
      L: cfg.L,
      K: engine.syms.length,
      rule: engine.feedbackRule,
      rem: Int32Array.from(remaining),
      pool: Int32Array.from(indices),
      hooks: engine.scoringHooks
    });
  }
  function rememberBits(scores, orderOf) {
    var i, s, word;
    for (i = 0; i < scores.length; i++) {
      s = scores[i];
      word = engine.keys[s.idx];
      openerBits[word] = s.ent;
      if (orderOf && orderOf[s.idx] == null) orderOf[s.idx] = i;
    }
  }
  function scoreRecords(scores, orderOf) {
    var out = [];
    var i, s;
    for (i = 0; i < scores.length; i++) {
      s = scores[i];
      out.push({
        word: engine.keys[s.idx],
        bits: s.ent,
        cand: s.cand,
        exp: s.exp,
        i: orderOf && orderOf[s.idx] != null ? orderOf[s.idx] : i
      });
    }
    return out;
  }
  function refreshOpeners() {
    if (!$('treePicks') || !engine) return;
    scanMarks = Object.create(null);
    openerBits = Object.create(null);
    var declared = packDeclaredOpeners();
    var authored = legalAuthoredOpeners();
    var scores = [];
    var orderOf = Object.create(null);
    openerCapped = false;
    if (remaining.length) {
      if (declared) {
        var ai, aidx = [];
        for (ai = 0; ai < authored.length; ai++) {
          aidx.push(engine.keyIdx.get(authored[ai]));
          orderOf[aidx[ai]] = ai;
        }
        scores = informationScores(aidx);
      } else {
        var cands = openerCandidateIdx();
        openerCapped = cands.capped;
        var ci;
        for (ci = 0; ci < cands.idx.length; ci++) orderOf[cands.idx[ci]] = ci;
        scores = informationScores(cands.idx);
      }
      rememberBits(scores, orderOf);
    }
    var chosen = Core.chooseOpenerList({
      declared: declared,
      authored: authored,
      scores: scoreRecords(scores, orderOf),
      capped: openerCapped,
      limit: Core.OPENER_GENERATED_CAP
    });
    openerWords = chosen.words;
    openerSource = chosen.source;
    openerCapped = chosen.capped;
    renderOpenerPicks();
    renderOpenerTable(openerWords);
    renderOpenerNote();
    var cur = ($('treeOpener').value || '').trim();
    var enc = cur ? engine.encode(cur) : null;
    var packChanged = openerPackSeen !== packGen;
    openerPackSeen = packGen;
    if (!cur || (enc && enc.err) || (packChanged && enc && !engine.keyIdx.has(enc.key))) {
      $('treeOpener').value = openerWords[0] || '';
    }
  }
  function renderOpenerPicks() {
    if (!$('treePicks')) return;
    $('treePicks').innerHTML = openerWords.map(function (w) {
      var label = showImages() ? wordHTML(w) : esc(showWord(w));
      return '<button type="button" class="ghost mini" data-pick="' + esc(w) + '">' + label + '</button>';
    }).join('');
    if ($('treeOpenerList')) {
      $('treeOpenerList').innerHTML = openerWords.map(function (w) {
        return '<option value="' + esc(w) + '"></option>';
      }).join('');
    }
  }
  function bitsCell(word) {
    var b = openerBits[word];
    if (b == null || b !== b) return '–';
    return fmt(b, 2);
  }
  function renderOpenerTable(words) {
    var table = $('treeOpenerTable');
    var wrap = $('treeOpenerWrap');
    if (!table || !table.tBodies[0]) return;
    if (wrap) wrap.hidden = !words.length;
    table.tBodies[0].innerHTML = words.map(function (w, i) {
      var mark = scanMarks[w] || '–';
      return '<tr data-word="' + esc(w) + '"><td>' + (i + 1) + '</td><td>' + wordHTML(w) +
        '</td><td>' + bitsCell(w) + '</td><td class="scan-mark">' + esc(mark) + '</td></tr>';
    }).join('');
  }
  function renderOpenerNote() {
    var el = $('treeOpenerNote');
    if (!el) return;
    var n = remaining.length;
    var metric = 'Bits are expected information against the ' + n.toLocaleString() +
      ' answers still possible: −∑ p log₂ p over the feedback patterns this pack would return. That is the same partition Analysis uses for its Bits column.';
    if (openerSource === 'pack') {
      el.textContent = openerWords.length
        ? 'Openers come from this pack’s list, in that order. ' + metric
        : 'This pack lists openers, and none of them are legal guesses at this length. ' + metric;
      return;
    }
    var capNote = openerCapped ? ' The candidate list was capped so a large pool would not hang the page.' : '';
    el.textContent = openerWords.length
      ? 'This pack has no opener list. These ' + openerWords.length +
        ' starters are the highest-information guesses among the pack’s guess list and the answers still possible.' +
        capNote + ' ' + metric
      : 'This pack has no opener list and no candidates to rank.' + capNote;
  }
  function setOpenerMark(word, text) {
    scanMarks[word] = text;
    var table = $('treeOpenerTable');
    if (!table || !table.tBodies[0]) return;
    var rows = table.tBodies[0].rows;
    var i, row;
    for (i = 0; i < rows.length; i++) {
      row = rows[i];
      row.classList.toggle('scanning', row.getAttribute('data-word') === word && text === 'trying');
      if (row.getAttribute('data-word') === word) {
        var cell = row.querySelector('.scan-mark');
        if (cell) cell.textContent = text;
      }
    }
  }
  function attachMissingBits(words) {
    var missing = [];
    var i;
    for (i = 0; i < words.length; i++) {
      if (openerBits[words[i]] == null && engine.keyIdx.has(words[i])) missing.push(engine.keyIdx.get(words[i]));
    }
    if (!missing.length) return;
    var scores = informationScores(missing);
    rememberBits(scores, null);
  }
  function haltTreeWork() {
    treeReq++;
    if (treeWorker) {
      treeWorker.onmessage = null;
      treeWorker.onerror = null;
      treeWorker.terminate();
      treeWorker = null;
    }
  }
  function dropTree() {
    scanJob = null;
    setScanRunning(false);
    haltTreeWork();
    treeResult = null;
    treeSig = '';
    treePath = [];
    renderTree();
    markActivePick('');
    var stale = $('treeStale');
    if (stale) stale.hidden = true;
    if ($('treeStatus') && !treeQueue) $('treeStatus').textContent = 'Choose a starting word and build its tree.';
  }
  function markActivePick(word) {
    if (!$('treePicks')) return;
    var want = foldWord(word || '');
    Array.prototype.forEach.call($('treePicks').querySelectorAll('[data-pick]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-pick') === want);
    });
  }
  function setScanRunning(on) {
    var b = $('treeScan');
    if (!b) return;
    b.textContent = on ? 'Stop' : 'Scan openers';
    b.classList.toggle('ghost', !on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function treeNode() {
    var node = treeResult && treeResult.root;
    var i, ch;
    if (!node) return null;
    for (i = 0; i < treePath.length; i++) {
      ch = node.children && node.children[treePath[i]];
      if (!ch || !ch.node) { treePath = treePath.slice(0, i); break; }
      node = ch.node;
    }
    return node;
  }
  function worstLine(node) {
    var line = [], guard = 0, cur = node, best, kids, i;
    while (cur && cur.guess != null && guard++ < 16) {
      line.push(cur.guess);
      best = null;
      kids = cur.children || [];
      for (i = 0; i < kids.length; i++) {
        if (!kids[i].node) continue;
        if (!best || (kids[i].maxDepth || 0) > (best.maxDepth || 0)) best = kids[i];
      }
      if (!best) break;
      cur = best.node;
    }
    return line;
  }
  function treeHonesty(s, root) {
    var parts = [];
    if (s.openerOutsidePool) parts.push('This starting guess is outside the current guess pool. It is still played first. Later guesses follow the active rules.');
    if (s.openerBreaksHard) parts.push('This starting guess breaks hard mode. Later guesses still have to obey it.');
    if (root && root.wasted) parts.push('This guess does not split the list. It costs a turn, then the policy continues.');
    if (!s.playedOut) {
      if (s.truncated) parts.push(s.unproved + ' answers were cut off before they were solved. They are unproved and are not a finish within n.');
      else if (s.unproved) parts.push(s.unproved + ' answers have no proved depth.');
      if (s.stuck) parts.push(s.stuck + (s.stuck === 1 ? ' answer has' : ' answers have') + ' no legal next guess under these rules.');
    } else if (s.guaranteed) {
      parts.push('Guaranteed: every answer is solved in ' + s.maxDepth + ' or fewer, and every later guess was an exhaustive choice.');
    } else if (s.strategyFits) {
      parts.push('This strategy solves every answer within n (worst ' + s.maxDepth + '). Some later guesses came from a shortlist, so this is weaker than the guarantee checkbox.');
    } else if (s.provedImpossible) {
      parts.push('Proved: under these rules, no worst-case line from this opener stays within n. The longest answer takes ' + s.maxDepth + '.');
    } else if (s.overBudget && s.policyApprox) {
      parts.push(s.overBudget + (s.overBudget === 1 ? ' answer takes' : ' answers take') + ' more than n on this strategy. A different continuation might still fit. That was not proved.');
    } else if (s.overBudget) {
      parts.push(s.overBudget + (s.overBudget === 1 ? ' answer takes' : ' answers take') + ' more than n on this ' + (s.policy === 'steps' ? 'expected-steps' : 'worst-case') + ' line.');
    }
    return parts.join(' ');
  }
  function renderTree() {
    var sumEl = $('treeSummary'), famEl = $('treeFamilies'), walkEl = $('treeWalk');
    if (!sumEl) return;
    if (!treeResult || !treeResult.root) {
      sumEl.innerHTML = '';
      famEl.innerHTML = '';
      walkEl.innerHTML = '';
      return;
    }
    var tree = treeResult, s = tree.summary, node = treeNode();
    var hist = {}, hi;
    tree.depths.forEach(function (d) {
      var k = d.proved ? String(d.depth) : '?';
      hist[k] = (hist[k] || 0) + 1;
    });
    var histKeys = Object.keys(hist).sort(function (a, b) {
      if (a === '?') return 1;
      if (b === '?') return -1;
      return (+a) - (+b);
    });
    var expTxt = s.expected == null ? '—' : fmt(s.expected, 2);
    var html = '<div class="tree-stats">';
    html += '<div class="stat' + (s.maxDepth > s.budget ? ' warn' : '') + '"><b>' + (s.maxDepth == null ? '—' : s.maxDepth) + '</b>max depth</div>';
    html += '<div class="stat' + (s.overBudget ? ' warn' : '') + '"><b>' + s.overBudget + '</b>over n</div>';
    html += '<div class="stat"><b>' + expTxt + '</b>expected</div>';
    html += '<div class="stat' + (s.unproved ? ' warn' : '') + '"><b>' + s.unproved + '</b>unproved</div>';
    html += '<div class="stat"><b>' + s.answers + '</b>answers</div>';
    html += '</div>';
    html += '<p class="muted small">' + esc(treeHonesty(s, tree.root)) + '</p>';
    if (histKeys.length) {
      html += '<p class="muted small">Depths: ' + histKeys.map(function (k) { return k + '×' + hist[k]; }).join(' · ') + '</p>';
    }
    sumEl.innerHTML = html;
    var listHtml = '';
    var shown = 0;
    for (hi = 0; hi < tree.depths.length; hi++) {
      var d = tree.depths[hi];
      var over = d.proved && d.depth > s.budget;
      if (treeOnlyOver && d.proved && !over) continue;
      var cls = 'ans' + (!d.proved ? ' unproved' : (over ? ' over' : ''));
      var title = d.proved ? (d.depth + ' · ' + (d.pats || []).map(function (p) { return patCode(patToDigits(p)); }).join(' → ')) : (d.reason || 'unproved');
      var chip = (showImages() && tree.depths.length <= 800) ? wordHTML(engine.keys[d.idx]) : esc(showWord(engine.keys[d.idx]));
      listHtml += '<span class="' + cls + '" title="' + esc(title) + '">' + chip + (d.proved ? ' ' + d.depth : ' ?') + '</span>';
      if (++shown >= 2500) break;
    }

    var groups = new Map();
    tree.depths.forEach(function (row) {
      if (!row.proved || row.depth <= s.budget) return;
      var pat = row.pats && row.pats.length ? row.pats[0] : -1;
      var g = groups.get(pat);
      if (!g) groups.set(pat, g = []);
      g.push(row);
    });
    var fams = [];
    groups.forEach(function (rows, pat) {
      rows.sort(function (a, b) { return b.depth - a.depth || a.idx - b.idx; });
      fams.push({ pat: pat, rows: rows });
    });
    fams.sort(function (a, b) { return b.rows[0].depth - a.rows[0].depth || b.rows.length - a.rows.length; });
    var famHtml = '';
    if (!fams.length && s.playedOut && !s.overBudget) famHtml = '<p class="ok small">Every played answer finishes within n.</p>';
    else if (fams.length) {
      famHtml = '<h3 style="font-size:14px;margin:12px 0 6px">Answers over n</h3>';
      fams.forEach(function (f) {
        var words = f.rows.map(function (row) { return engine.keys[row.idx]; });
        famHtml += '<div class="tree-row tree-over"><div class="row">';
        if (f.pat >= 0 && tree.root.guess != null) {
          famHtml += tilesHTML(treeSyms(tree.root.guess), patToDigits(f.pat));
          famHtml += '<span class="code">' + esc(patCode(patToDigits(f.pat))) + '</span>';
        }
        famHtml += '<span class="cnt">' + f.rows.length + ' over</span><span>max ' + f.rows[0].depth + '</span>';
        famHtml += '<span class="preview">' + esc(words.slice(0, 16).join(' ')) + (words.length > 16 ? ' …' : '') + '</span>';
        famHtml += '</div></div>';
      });
      var line = worstLine(tree.root).map(function (gi) { return showWord(treeWord(gi)); });
      if (line.length) famHtml += '<p class="muted small">Longest branch: ' + esc(line.join(' → ')) + '</p>';
    }
    if (s.unproved) famHtml += '<p class="muted small">' + s.unproved + ' answers are unproved on this build.</p>';
    famEl.innerHTML = famHtml;

    if (!node) { walkEl.innerHTML = ''; return; }
    var crumbs = '<div class="tree-crumb"><button type="button" class="ghost mini" data-crumb="0">' + esc(showWord(treeWord(tree.root.guess)) || 'opener') + '</button>';
    var walk = tree.root, ci;
    for (ci = 0; ci < treePath.length; ci++) {
      var step = walk.children[treePath[ci]];
      if (!step) break;
      var crumb = patCode(patToDigits(step.pat));
      if (step.node && step.node.guess != null) crumb += ' ' + showWord(treeWord(step.node.guess));
      crumbs += '<span class="muted">›</span><button type="button" class="ghost mini" data-crumb="' + (ci + 1) + '">' + esc(crumb) + '</button>';
      if (!step.node) break;
      walk = step.node;
    }
    crumbs += '</div>';
    var mark = (!node.forced && node.policyExact === false) ? ' ≈' : '';
    var headWord = treeWord(node.guess);
    var headFace = headWord ? (showImages() ? wordHTML(headWord) : esc(showWord(headWord))) : '—';
    var head = '<div class="tree-head"><b>' + headFace + mark + '</b>';
    head += '<span class="muted small">' + node.n + ' answers';
    if (node.maxDepth != null) head += ' · max ' + node.maxDepth;
    if (node.over) head += ' · ' + node.over + ' over n';
    if (node.wasted) head += ' · no split';
    if (node.cut) head += ' · cut off';
    if (node.stuck) head += ' · no legal guess';
    head += '</span></div>';
    if (node.cut) head += '<p class="warn small">This branch was cut off. Its answers are unproved.</p>';
    if (node.stuck) head += '<p class="warn small">No legal guess separates this set under the current rules.</p>';
    var rows = '';
    var kids = node.children || [];
    for (ci = 0; ci < kids.length; ci++) {
      var ch = kids[ci];
      var open = ch.node ? ' tree-open' : '';
      var hot = ch.over ? ' tree-over' : '';
      var words = (ch.answers || []).slice(0, 12).map(function (idx) { return engine.keys[idx]; });
      rows += '<div class="tree-row' + open + hot + '"><div class="row"' + (ch.node ? ' data-down="' + ci + '"' : '') + '>';
      rows += tilesHTML(treeSyms(node.guess), patToDigits(ch.pat));
      rows += '<span class="code">' + esc(patCode(patToDigits(ch.pat))) + '</span>';
      rows += '<span class="cnt">' + (ch.solved ? 'solved' : ch.n + ' left') + '</span>';
      if (ch.solved) rows += '<span class="next">solved</span>';
      else if (ch.node && ch.node.guess != null) rows += '<span class="next">' + wordHTML(treeWord(ch.node.guess)) + ((!ch.node.forced && ch.node.policyExact === false) ? ' ≈' : '') + '</span>';
      else rows += '<span class="next">…</span>';
      if (ch.maxDepth != null) rows += '<span' + (ch.maxDepth > s.budget ? ' class="warn"' : '') + '>max ' + ch.maxDepth + '</span>';
      if (ch.over) rows += '<span class="warn">' + ch.over + ' over</span>';
      if (ch.unproved) rows += '<span class="muted">' + ch.unproved + ' unproved</span>';
      rows += '<span class="preview">' + esc(words.join(' ')) + ((ch.answers && ch.answers.length > 12) ? ' …' : '') + '</span>';
      rows += '<button type="button" class="ghost mini" data-use="' + ch.pat + '">use</button>';
      rows += '</div></div>';
    }
    if (!kids.length && node.solved) {
      rows = '<p class="ok small">Solved in ' + node.maxDepth + '.</p>';
    }
    var checked = treeOnlyOver ? ' checked' : '';
    var list = '<details class="tree-all"' + (treeListOpen ? ' open' : '') + '><summary>All answers by depth (' + tree.depths.length + ')</summary>';
    list += '<label class="chk"><input type="checkbox" id="treeOnlyOver"' + checked + '> Hide answers within n</label>';
    list += '<div class="tree-answers">' + listHtml + '</div></details>';
    walkEl.innerHTML = crumbs + head + rows + list;
  }
  function treeOpenerValue() {
    return ($('treeOpener') && $('treeOpener').value || '').trim();
  }
  function setTreeWarn(msg) {
    var el = $('treeStatus');
    if (!el) return;
    el.innerHTML = '<span class="warn">' + esc(msg) + '</span>';
  }
  function rememberTreeQueue() {
    treeQueue = { kind: 'build', opener: treeOpenerValue(), userEdited: false };
  }
  function failQueuedPack() {
    if (!treeQueue) return;
    treeQueue = null;
    var blocked = TreeStatus.blockReason({ hasEngine: false, packPhase: 'failed', packError: packError });
    setTreeWarn(blocked.message);
  }
  // Pack readiness can land in the same turn that restores saved clues. Build on the next turn.
  function scheduleTreeFlush() {
    if (!treeQueue || !engine || packPhase !== 'ready') return;
    var token = ++treeFlushToken;
    var gen = packGen;
    setTimeout(function () {
      if (token !== treeFlushToken || gen !== packGen) return;
      flushTreeQueue();
    }, 0);
  }
  function flushTreeQueue() {
    if (!treeQueue || !engine || packPhase !== 'ready') return;
    if (treeQueue.kind === 'scan') {
      treeQueue = null;
      scanOpeners();
      return;
    }
    if (!TreeStatus.queueStillCurrent(treeQueue, treeOpenerValue())) {
      treeQueue = null;
      setTreeWarn(TreeStatus.openerChanged);
      return;
    }
    treeQueue = null;
    runTree();
  }
  function clueSigNow() {
    return clues.map(function (c) { return c.key + ':' + c.pat; }).join(',');
  }
  function remHashNow() {
    var h = 0, i;
    for (i = 0; i < remaining.length; i++) h = (h * 33 + remaining[i]) | 0;
    return h;
  }
  function readTreeBudget() {
    var n = parseInt($('treeBudget').value, 10);
    if (n) {
      cfg.steps = Math.max(1, Math.min(30, n));
      $('treeBudget').value = cfg.steps;
      if ($('cfgSteps')) $('cfgSteps').value = cfg.steps;
    }
    cfg.treePolicy = ($('treePolicy') && $('treePolicy').value) || cfg.treePolicy || 'worst';
  }
  function takeTreeSnap() {
    readTreeBudget();
    return {
      rem: Int32Array.from(remaining),
      guessIdx: Int32Array.from(treeGuessIdx()),
      clues: clues.map(function (c) {
        return { ids: Array.prototype.slice.call(c.ids), pat: c.pat, digits: c.digits.slice() };
      }),
      hard: cfg.hard,
      guessMode: cfg.guessMode,
      layer: cfg.layer,
      rule: cfg.rule,
      valid: cfg.valid,
      budget: cfg.steps,
      policy: cfg.treePolicy,
      clueSig: clueSigNow(),
      remHash: remHashNow()
    };
  }
  function snapStillCurrent(snap) {
    return snap.hard === cfg.hard && snap.guessMode === cfg.guessMode && snap.layer === cfg.layer &&
      snap.policy === cfg.treePolicy && snap.budget === cfg.steps && snap.rule === cfg.rule &&
      snap.valid === cfg.valid && snap.clueSig === clueSigNow() &&
      snap.remHash === remHashNow() && snap.rem.length === remaining.length;
  }
  function treeMessage(enc, snap, id) {
    var idx = engine.keyIdx.has(enc.key) ? engine.keyIdx.get(enc.key) : -1;
    var msg = {
      type: 'tree', id: id,
      U: engine.U, L: cfg.L, K: engine.syms.length, rule: engine.feedbackRule,
      rem: snap.rem, guessIdx: snap.guessIdx, clues: snap.clues,
      hard: snap.hard, guessMode: snap.guessMode,
      opener: idx, openerIds: Array.prototype.slice.call(enc.ids),
      budget: snap.budget, policy: snap.policy,
      limits: { timeCapMs: 12000 }
    };
    if (engine.feedbackSource) {
      msg.feedbackSource = engine.feedbackSource;
      msg.syms = engine.syms;
      msg.clueBase = engine.clueBase;
      msg.greenDigit = engine.greenDigit;
      msg.correctValues = engine.correctValues;
      msg.revealedValues = engine.revealedValues;
    }
    return msg;
  }
  function openerScanPlan() {
    var remWords = [], i;
    for (i = 0; i < remaining.length; i++) remWords.push(engine.keys[remaining[i]]);
    var dictWords = [];
    if (remaining.length > 0 && remaining.length <= SCAN_EXTRA_MAX_REM) {
      var remSet = {};
      for (i = 0; i < remaining.length; i++) remSet[remaining[i]] = 1;
      var probes = [], ruledOut = [], g = treeGuessIdx(), idx;
      for (i = 0; i < g.length; i++) {
        idx = g[i];
        if (remSet[idx]) continue;
        if (engine.flags[idx] && engine.flags[idx].known) ruledOut.push(engine.keys[idx]);
        else probes.push(engine.keys[idx]);
      }
      dictWords = probes.concat(ruledOut);
    }
    return Core.planOpenerScan({
      openers: openerWords,
      has: function (w) { return engine.keyIdx.has(w); },
      remaining: remWords,
      dict: dictWords,
      extraMaxRemaining: SCAN_EXTRA_MAX_REM,
      extraCap: SCAN_EXTRA_CAP
    });
  }
  function dispatchTree(id, msg, onTree, onFail) {
    var fellBack = false;
    var workerErr = '';
    function syncTree(fromWorker) {
      if (fromWorker) workerErr = TreeStatus.errorText(fromWorker, 'Worker failed.');
      if (fellBack || id !== treeReq) return;
      fellBack = true;
      if (treeWorker) {
        treeWorker.onmessage = null;
        treeWorker.onerror = null;
        treeWorker.terminate();
        treeWorker = null;
      }
      setTimeout(function () {
        if (id !== treeReq) return;
        try {
          var t0 = Date.now();
          var tree = Core.buildOpenerTree(Object.assign({}, msg, { hooks: engine && engine.scoringHooks }), function (done, total) {
            if (id !== treeReq) return;
            var bar = $('treeBar');
            if (bar) bar.style.width = (100 * done / Math.max(1, total)) + '%';
          });
          onTree(tree, Date.now() - t0);
        } catch (err) {
          onFail(TreeStatus.errorText(err, '') || workerErr || 'Tree build failed.');
        }
      }, 10);
    }
    if (treeWorker) {
      treeWorker.onmessage = null;
      treeWorker.onerror = null;
      treeWorker.terminate();
      treeWorker = null;
    }
    try {
      if (location.protocol === 'file:') throw new Error('no worker on file://');
      treeWorker = new Worker('worker.js');
      treeWorker.onmessage = function (e) {
        var d = e.data;
        if (!d || d.id !== id || d.id !== treeReq) return;
        try {
          if (d.type === 'progress') {
            var bar = $('treeBar');
            if (bar) bar.style.width = (100 * d.done / Math.max(1, d.total)) + '%';
            return;
          }
          if (d.type === 'error') {
            syncTree(d.message || 'Worker failed.');
            return;
          }
          if (d.type === 'tree') {
            var w = treeWorker;
            onTree(d.tree, d.ms);
            if (treeWorker === w && treeWorker) {
              treeWorker.onmessage = null;
              treeWorker.onerror = null;
              treeWorker.terminate();
              treeWorker = null;
            }
          }
        } catch (err) {
          onFail(err);
        }
      };
      treeWorker.onerror = function (ev) {
        syncTree((ev && ev.message) || 'Worker failed.');
        if (ev && ev.preventDefault) ev.preventDefault();
      };
      treeWorker.postMessage(msg);
    } catch (err) { syncTree(err); }
  }
  function runTree() {
    if (scanJob) {
      scanJob = null;
      setScanRunning(false);
      haltTreeWork();
    }
    var raw = treeOpenerValue();
    var enc = null;
    var packReady = !!engine && packPhase !== 'loading';
    if (packReady) {
      try { enc = engine.encode(raw); }
      catch (err) {
        treeQueue = null;
        setTreeWarn(TreeStatus.errorText(err));
        return;
      }
    }
    var blocked = TreeStatus.blockReason({
      hasEngine: packReady,
      packPhase: packPhase,
      packError: packError,
      raw: raw,
      encodeErr: enc && enc.err,
      remaining: remaining.length
    });
    if (blocked) {
      if (blocked.queue) rememberTreeQueue();
      else treeQueue = null;
      setTreeWarn(blocked.message);
      return;
    }
    treeQueue = null;
    var id, sig, msg;
    try {
      var snap = takeTreeSnap();
      id = ++treeReq;
      sig = currentTreeSig();
      msg = treeMessage(enc, snap, id);
    } catch (err) {
      setTreeWarn(TreeStatus.errorText(err));
      return;
    }
    function show(tree, ms) {
      if (id !== treeReq) return;
      treeResult = tree;
      treeSig = sig;
      treePath = [];
      treeOnlyOver = false;
      treeListOpen = false;
      renderTree();
      markActivePick(enc.key);
      var tail = 'Built in ' + ms + ' ms.';
      if (tree.summary.truncated) tail += ' Stopped at the time limit.';
      $('treeStatus').textContent = tail;
      markTreeStale();
      saveState();
    }
    function failTree(err) {
      if (id !== treeReq) return;
      if (treeWorker) {
        treeWorker.onmessage = null;
        treeWorker.onerror = null;
        treeWorker.terminate();
        treeWorker = null;
      }
      setTreeWarn(TreeStatus.errorText(err));
    }
    $('treeStatus').innerHTML = 'Building tree for <b>' + esc(showWord(enc.key)) + '</b>…<div class="bar"><i id="treeBar"></i></div>';
    dispatchTree(id, msg, show, failTree);
  }
  function showFinishedTree(hit) {
    $('treeOpener').value = hit.word;
    markActivePick(hit.word);
    treeResult = hit.tree;
    treeSig = hit.sig;
    treePath = [];
    treeOnlyOver = false;
    treeListOpen = false;
    renderTree();
    markTreeStale();
  }
  function clearTryingMarks() {
    var word, table, rows, i, cell;
    for (word in scanMarks) if (scanMarks[word] === 'trying') scanMarks[word] = 'stopped';
    table = $('treeOpenerTable');
    if (!table || !table.tBodies[0]) return;
    rows = table.tBodies[0].rows;
    for (i = 0; i < rows.length; i++) {
      rows[i].classList.remove('scanning');
      cell = rows[i].querySelector('.scan-mark');
      if (cell && cell.textContent === 'trying') cell.textContent = 'stopped';
    }
  }
  function stopScan(reason) {
    var job = scanJob;
    scanJob = null;
    setScanRunning(false);
    haltTreeWork();
    clearTryingMarks();
    if (!$('treeStatus')) return;
    if (job && (job.best || job.last)) showFinishedTree(job.best || job.last);
    else markActivePick(treeOpenerValue());
    if (reason) {
      $('treeStatus').textContent = reason;
      return;
    }
    if (!job) {
      $('treeStatus').textContent = 'Scan stopped.';
      return;
    }
    var word = job.plan.all[job.i] || '';
    var stopped;
    if (!job.tried) stopped = 'Scan stopped during ' + showWord(word) + ' (' + (job.i + 1) + '/' + job.plan.all.length + ').';
    else stopped = 'Scan stopped after ' + job.tried + ' of ' + job.plan.all.length + '.';
    if (job.best && job.best.summary.maxDepth != null) {
      stopped += ' Best max depth so far was ' + job.best.summary.maxDepth + ' (' + showWord(job.best.word) + ').';
    }
    $('treeStatus').textContent = stopped;
  }
  function finishScan(job) {
    scanJob = null;
    setScanRunning(false);
    var show = job.best || job.last;
    if (show) showFinishedTree(show);
    var n = job.snap.budget;
    var text;
    if (!job.tried) text = 'None of the starters could be built under these settings.';
    else text = 'None of the ' + job.tried + ' tried openers fit n=' + n + ' under these settings.';
    if (job.best && job.best.summary.maxDepth != null) {
      text += ' Best max depth was ' + job.best.summary.maxDepth + ' (' + showWord(job.best.word) + ').';
    } else if (job.tried) {
      text += ' No opener played out every answer.';
    }
    if (job.cut) text += ' ' + job.cut + (job.cut === 1 ? ' was' : ' were') + ' cut off before every answer was solved.';
    $('treeStatus').textContent = text;
    saveState();
  }
  function showScanFit(hit) {
    scanJob = null;
    setScanRunning(false);
    showFinishedTree(hit);
    var s = hit.summary;
    $('treeStatus').textContent = showWord(hit.word) + ' fits n=' + s.budget + ' (max ' + s.maxDepth + ').';
    saveState();
  }
  function stepScan() {
    var job = scanJob;
    if (!job) return;
    if (!snapStillCurrent(job.snap)) {
      stopScan('Scan stopped because the settings or clues changed.');
      return;
    }
    if (job.i >= job.plan.all.length) {
      finishScan(job);
      return;
    }
    var word = job.plan.all[job.i];
    var enc = engine.encode(word);
    if (!enc || enc.err) {
      job.i++;
      stepScan();
      return;
    }
    $('treeOpener').value = enc.key;
    markActivePick(enc.key);
    var id = ++treeReq;
    var sig = currentTreeSig();
    var msg;
    try { msg = treeMessage(enc, job.snap, id); }
    catch (err) {
      setTreeWarn(TreeStatus.errorText(err));
      scanJob = null;
      setScanRunning(false);
      return;
    }
    setOpenerMark(enc.key, 'trying');
    var bitLabel = bitsCell(enc.key);
    $('treeStatus').innerHTML = 'Trying <b>' + esc(showWord(enc.key)) + '</b>' +
      (bitLabel === '–' ? '' : ' · ' + esc(bitLabel) + ' bits') + '… ' +
      (job.i + 1) + '/' + job.plan.all.length +
      '<div class="bar"><i id="treeBar"></i></div>';
    dispatchTree(id, msg, function (tree, ms) {
      if (scanJob !== job || id !== treeReq) return;
      if (!snapStillCurrent(job.snap)) {
        stopScan('Scan stopped because the settings or clues changed.');
        return;
      }
      job.tried++;
      job.i++;
      if (tree && tree.summary) {
        var hit = { word: enc.key, tree: tree, sig: sig, summary: tree.summary };
        job.last = hit;
        if (tree.summary.truncated) job.cut++;
        if (tree.summary.playedOut && tree.summary.maxDepth != null &&
            (job.best == null || tree.summary.maxDepth < job.best.summary.maxDepth)) {
          job.best = hit;
        }
        if (tree.summary.strategyFits) {
          setOpenerMark(enc.key, 'fits');
          showScanFit(hit);
          return;
        }
        if (tree.summary.truncated) setOpenerMark(enc.key, 'cut off');
        else if (tree.summary.playedOut && tree.summary.maxDepth != null) setOpenerMark(enc.key, 'max ' + tree.summary.maxDepth);
        else setOpenerMark(enc.key, 'unproved');
      }
      setTimeout(function () { if (scanJob === job) stepScan(); }, 0);
    }, function (err) {
      if (scanJob !== job || id !== treeReq) return;
      setTreeWarn(TreeStatus.errorText(err));
      scanJob = null;
      setScanRunning(false);
    });
  }
  function scanOpeners() {
    if (scanJob) {
      stopScan();
      return;
    }
    var packReady = !!engine && packPhase !== 'loading';
    if (!packReady) {
      if (packPhase === 'failed') {
        treeQueue = null;
        setTreeWarn(TreeStatus.blockReason({ hasEngine: false, packPhase: 'failed', packError: packError }).message);
        return;
      }
      treeQueue = { kind: 'scan', opener: treeOpenerValue(), userEdited: false };
      setTreeWarn('Game setup is still loading. The scan will start when the pack is ready.');
      return;
    }
    treeQueue = null;
    if (!remaining.length) {
      setTreeWarn('No answers left to build a tree on.');
      return;
    }
    var plan = openerScanPlan();
    if (!plan.all.length) {
      var why;
      if (!plan.continued && openerSource === 'pack') {
        why = 'None of the quick-pick starters are in this pack. ' + remaining.length + ' answers are left, so further openers are not scanned.';
      } else if (!plan.continued) {
        why = 'No opener candidates to scan. ' + remaining.length + ' answers are left, so further openers are not scanned.';
      } else {
        why = 'No starters to try on this list.';
      }
      $('treeStatus').textContent = why;
      return;
    }
    attachMissingBits(plan.all);
    scanMarks = Object.create(null);
    renderOpenerTable(plan.all);
    var snap;
    try { snap = takeTreeSnap(); }
    catch (err) {
      setTreeWarn(TreeStatus.errorText(err));
      return;
    }
    haltTreeWork();
    scanJob = { plan: plan, snap: snap, i: 0, tried: 0, cut: 0, best: null, last: null };
    setScanRunning(true);
    treeResult = null;
    treeSig = '';
    treePath = [];
    renderTree();
    var stale = $('treeStale');
    if (stale) stale.hidden = true;
    saveState();
    stepScan();
  }
  $('treeBuild').addEventListener('click', runTree);
  $('treeScan').addEventListener('click', scanOpeners);
  $('treeOpener').addEventListener('keydown', function (e) { if (e.key === 'Enter') runTree(); });
  $('treeOpener').addEventListener('input', function () {
    markTreeStale();
    if (!treeQueue) return;
    treeQueue.userEdited = foldWord(treeOpenerValue()) !== foldWord(treeQueue.opener || '');
  });
  $('treePolicy').addEventListener('change', function () {
    cfg.treePolicy = this.value;
    markTreeStale();
    saveState();
  });
  $('treeBudget').addEventListener('change', function () {
    cfg.stepsTouched = true;
    cfg.steps = Math.max(1, Math.min(30, parseInt(this.value, 10) || 1));
    this.value = cfg.steps;
    if ($('cfgSteps')) $('cfgSteps').value = cfg.steps;
    markTreeStale();
    saveState();
    if (cfg.page !== 'tree') scheduleScore();
  });
  $('treePicks').addEventListener('click', function (e) {
    var b = e.target.closest('[data-pick]');
    if (!b) return;
    $('treeOpener').value = b.getAttribute('data-pick');
    runTree();
  });
  $('treeCard').addEventListener('click', function (e) {
    var use = e.target.closest('[data-use]');
    if (use) {
      e.preventDefault();
      var node = treeNode();
      if (node) addClue(treeWord(node.guess), patToDigits(+use.getAttribute('data-use')));
      return;
    }
    var down = e.target.closest('[data-down]');
    if (down) {
      var cur = treeNode();
      var ch = cur && cur.children && cur.children[+down.getAttribute('data-down')];
      if (ch && ch.node) { treePath.push(+down.getAttribute('data-down')); renderTree(); }
      return;
    }
    var crumb = e.target.closest('[data-crumb]');
    if (!crumb) return;
    treePath = treePath.slice(0, +crumb.getAttribute('data-crumb'));
    renderTree();
  });
  $('treeCard').addEventListener('change', function (e) {
    if (e.target.id !== 'treeOnlyOver') return;
    treeOnlyOver = e.target.checked;
    treeListOpen = true;
    renderTree();
  });
  $('treeCard').addEventListener('toggle', function (e) {
    if (e.target.classList && e.target.classList.contains('tree-all')) treeListOpen = !!e.target.open;
  }, true);

  var GUESS_FIELDS = ['clueGuess', 'cluePat', 'bdGuess', 'treeOpener'];
  var keyTarget = 'clueGuess';
  var PAINT_OK = { b: 1, y: 1, g: 1, yp: 1, gp: 1 };
  var createLoaded = false;
  var createFileText = '';
  var viewedManifest = null;
  var GH_BLOB = 'https://github.com/geekahedron/solver/blob/master/';
  var CREATE_SOURCES = [
    { id: 'template', label: 'Blank template', template: true },
    { id: 'wordle-en', label: 'English Wordle-style (wordle-en.json)', file: 'packs/wordle-en.json', github: 'src/packs/wordle-en.json' },
    { id: 'wordle-nyt', label: 'NYT WordleBot (wordle-nyt.json)', file: 'packs/wordle-nyt.json', github: 'src/packs/wordle-nyt.json' },
    { id: 'dungleon', label: 'Dungleon (dungleon.json)', file: 'packs/dungleon.json', github: 'src/packs/dungleon.json' },
    { id: 'mastermind', label: 'Mastermind sketch (not playable)', file: 'packs/mastermind-sketch.json', github: 'src/packs/mastermind-sketch.json' }
  ];

  function templateManifest() {
    return {
      id: 'my-game',
      name: 'My game',
      note: 'Starter pack. Edit the lists, or replace them with an https URL of a plain text word list.',
      delimiter: 'none',
      caseInsensitive: true,
      clueShape: 'perSlot',
      clueAlphabet: [
        { id: 'absent', value: 0, label: 'B', role: 'absent', paint: 'b', symbols: ['b', 'r', 'x', 'w', '0'] },
        { id: 'present', value: 1, label: 'Y', role: 'present', paint: 'y', symbols: ['y', 'p', 'o', '1'] },
        { id: 'correct', value: 2, label: 'G', role: 'correct', paint: 'g', solve: true, symbols: ['g', 'c', '2'] }
      ],
      tokenRenderer: 'tiles/letters',
      clueRenderer: 'clues/wordle-gyb',
      feedback: 'wordle',
      rules: 'builtin:wordle',
      alphabet: 'abcdefghijklmnopqrstuvwxyz',
      pools: { theoretical: 'guessList' },
      guessMode: 'dictionary',
      openers: ['crane', 'slate', 'trace'],
      variants: [{
        id: 'my-game-5',
        name: 'My game (5)',
        length: 5,
        knownSolutions: ['crane', 'slate', 'trace', 'raise', 'stare'],
        guessList: ['crane', 'slate', 'trace', 'raise', 'stare', 'alert']
      }]
    };
  }

  function templateText() {
    return JSON.stringify(templateManifest(), null, 2) + '\n';
  }

  function keyboardAutoOpen() {
    var narrow = false;
    try {
      narrow = window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
    } catch (e) {}
    if (narrow) return true;
    var pack = engine && engine.pack;
    if (!pack) return false;
    if (pack.caseInsensitive === false) return true;
    if (pack.appearance) return true;
    var tokens = Pack.alphabetTokens(pack);
    var az = tokens.length && tokens.every(function (t) { return /^[a-z]$/.test(t); });
    return !az;
  }
  function keyboardIsOpen() {
    if (cfg.keyboardOpen === true || cfg.keyboardOpen === false) return cfg.keyboardOpen;
    return keyboardAutoOpen();
  }
  function syncKeyboardOpen() {
    var wrap = $('keyboardWrap');
    var btn = $('keyboardToggle');
    if (!wrap || !btn) return;
    var open = keyboardIsOpen();
    wrap.classList.toggle('collapsed', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? 'Hide keyboard' : 'Show keyboard';
  }
  function keyEl() {
    if (keyTarget && keyTarget.nodeType === 1) {
      if (document.body.contains(keyTarget)) return keyTarget;
      keyTarget = 'clueGuess';
    }
    return $(keyTarget) || $('clueGuess');
  }
  function markKeyTarget() {
    var elTarget = keyTarget && keyTarget.nodeType === 1 ? keyTarget : null;
    if (elTarget && !document.body.contains(elTarget)) {
      keyTarget = 'clueGuess';
      elTarget = null;
    }
    GUESS_FIELDS.forEach(function (id) {
      var el = $(id);
      if (el) el.classList.toggle('key-target', !elTarget && id === keyTarget);
    });
    var board = $('gauntletBoard');
    if (!board) return;
    Array.prototype.forEach.call(board.querySelectorAll('[data-gauntlet-field]'), function (el) {
      el.classList.toggle('key-target', el === elTarget);
    });
  }
  function keyPaint() {
    var best = Object.create(null);
    if (!engine || !engine.pack) return best;
    var marks = engine.pack.clueAlphabet || [];
    function meta(digit) {
      var i;
      for (i = 0; i < marks.length; i++) if (marks[i].value === digit) return marks[i];
      return null;
    }
    function rank(m) {
      if (!m) return 0;
      if (m.role === 'correct' && m.plus) return 5;
      if (m.role === 'correct' || m.solve) return 4;
      if (m.role === 'present' && m.plus) return 3;
      if (m.role === 'present') return 2;
      if (m.role === 'absent' || m.value === 0) return 1;
      return 0;
    }
    clues.forEach(function (c) {
      var i, m, r, sym, paint;
      for (i = 0; i < c.syms.length; i++) {
        sym = c.syms[i];
        if (!sym) continue;
        m = meta(c.digits[i]);
        r = rank(m);
        paint = m && PAINT_OK[m.paint] ? m.paint : '';
        if (!best[sym] || r > best[sym].rank) best[sym] = { rank: r, paint: paint };
      }
    });
    return best;
  }
  function keyButton(sym, paint) {
    var face = showImages() ? Renderers.entityFace(sym, artOpts({ art: 'sprite', caption: false })) : '';
    var cls = 'key' + (face ? ' art' : '') + (paint ? ' ' + paint : '');
    var name = entityAccessibleName(sym);
    return '<button type="button" class="' + cls + '" data-key="' + esc(sym) + '" aria-label="' + esc(name) + '" title="' + esc(name) + '">' +
      face + '<span class="key-cap">' + esc(sym) + '</span></button>';
  }
  function renderKeyboard() {
    var el = $('keyboard');
    if (!el) return;
    var pack = engine && engine.pack;
    var rows = pack ? Pack.keyboardRows(pack) : [];
    var paints = keyPaint();
    var html = rows.map(function (row) {
      return '<div class="key-row">' + row.map(function (sym) {
        var paint = paints[sym] && paints[sym].paint;
        return keyButton(sym, paint);
      }).join('') + '</div>';
    }).join('');
    html += '<div class="key-row key-row-actions"><button type="button" class="key key-wide" data-key="Backspace" aria-label="Backspace">Back</button>' +
      '<button type="button" class="key key-wide" data-key="Enter" aria-label="Enter">Enter</button></div>';
    el.innerHTML = html;
    syncKeyboardOpen();
    markKeyTarget();
  }
  function insertInto(el, text) {
    var start = el.selectionStart, end = el.selectionEnd, value = el.value || '';
    if (start == null || end == null) {
      el.value = value + text;
      return;
    }
    el.value = value.slice(0, start) + text + value.slice(end);
    var pos = start + text.length;
    try { el.setSelectionRange(pos, pos); } catch (e) {}
  }
  function backspaceIn(el) {
    var start = el.selectionStart, end = el.selectionEnd, value = el.value || '';
    if (start == null || end == null) { el.value = value.slice(0, -1); return; }
    if (start !== end) {
      el.value = value.slice(0, start) + value.slice(end);
      try { el.setSelectionRange(start, start); } catch (e) {}
      return;
    }
    if (!start) return;
    el.value = value.slice(0, start - 1) + value.slice(end);
    try { el.setSelectionRange(start - 1, start - 1); } catch (e) {}
  }
  function submitKeyTarget() {
    if (keyTarget && keyTarget.nodeType === 1 && keyTarget.getAttribute('data-gauntlet-field')) {
      var kind = keyTarget.getAttribute('data-gauntlet-field');
      var floor = +keyTarget.getAttribute('data-floor');
      if (kind === 'solution') return;
      if (kind === 'guess') {
        var pat = $('gPat' + floor);
        if (pat && !pat.value) { pat.focus(); return; }
      }
      submitFloor(floor);
      return;
    }
    if (keyTarget === 'bdGuess') { $('bdBtn').click(); return; }
    if (keyTarget === 'treeOpener') { $('treeBuild').click(); return; }
    if (keyTarget === 'clueGuess' && !$('cluePat').value) { $('cluePat').focus(); return; }
    $('addClueBtn').click();
  }
  function onKeyPress(key) {
    var el = keyEl();
    if (!el) return;
    if (key === 'Enter') { submitKeyTarget(); return; }
    if (key === 'Backspace') {
      backspaceIn(el);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    insertInto(el, key);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    try { el.focus(); } catch (e) {}
  }

  function loadShippedRules(pack) {
    var id = (pack && pack.rules) || 'builtin:wordle';
    if (id.indexOf('script:') !== 0) return Promise.resolve(Pack.resolveRules(pack));
    var rel = id.slice('script:'.length);
    if (!Pack.shippedRuleScript(rel)) {
      return Promise.reject(new Error('This pack names a rules script this page will not run (' + rel + '). Use builtin:wordle, builtin:simple, rules/wordle.js, or rules/dungleon.js.'));
    }
    return Pack.loadRules(pack, function (path) {
      if (!Pack.shippedRuleScript(path)) return Promise.reject(new Error('Refusing to load ' + path));
      return fetch('packs/' + path).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      });
    });
  }
  function loadJsonPack(key, gen, keepClues, applyDefaults) {
    var rec = jsonPacks()[key];
    if (!rec || !rec.manifest) {
      packPhase = 'failed';
      packError = 'Saved pack is missing';
      $('packMsg').textContent = 'That custom pack is no longer in this browser.';
      failQueuedPack();
      return Promise.resolve();
    }
    var manifest = rec.manifest;
    var variant = null;
    (manifest.variants || []).forEach(function (v) { if (v && v.id === rec.variantId) variant = v; });
    if (!variant) {
      variant = (manifest.variants && manifest.variants[0]) || {
        id: manifest.id, name: manifest.name, length: manifest.length,
        knownSolutions: manifest.knownSolutions, guessList: manifest.guessList
      };
    }
    var pack;
    try { pack = Pack.normalize(manifest, variant); }
    catch (err) {
      packPhase = 'failed';
      packError = TreeStatus.errorText(err);
      $('packMsg').textContent = 'Could not read this custom pack (' + packError + ').';
      failQueuedPack();
      return Promise.resolve();
    }
    $('packMsg').textContent = 'Loading…';
    return loadShippedRules(pack).then(function (rules) {
      if (gen !== packGen) return;
      mountFetchedPack(pack, manifest, variant, null, rec.answers || '', rec.guesses || '', rules, keepClues, applyDefaults);
    }).catch(function (err) {
      if (gen !== packGen) return;
      packPhase = 'failed';
      packError = (err && err.message) ? err.message : String(err || 'load failed');
      $('packMsg').textContent = 'Could not load this custom pack (' + packError + ').';
      failQueuedPack();
    });
  }
  function deleteJsonPack(key) {
    var jp = jsonPacks();
    delete jp[key];
    try { localStorage.setItem(LS_JSON, JSON.stringify(jp)); } catch (e) {}
    renderCreateSaved();
  }
  function listText(value) {
    var kind = Pack.classifyList(value);
    if (kind.kind === 'empty') return Promise.resolve('');
    if (kind.kind === 'bad') return Promise.reject(new Error('not a word list this page can load'));
    if (kind.kind === 'array') {
      return Promise.resolve(value.map(function (w) { return String(w).trim(); }).filter(Boolean).join('\n'));
    }
    if (kind.kind === 'url') {
      return fetchRemoteText(kind.url, 20000).then(function (text) {
        if (!text || !String(text).trim()) throw new Error('the list was empty');
        if (String(text).length > 2000000) throw new Error('that list is too large');
        return text;
      });
    }
    return fetch('packs/' + kind.file).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for packs/' + kind.file);
      return r.text();
    });
  }

  function createSourceById(id) {
    var i;
    for (i = 0; i < CREATE_SOURCES.length; i++) if (CREATE_SOURCES[i].id === id) return CREATE_SOURCES[i];
    return CREATE_SOURCES[0];
  }
  function fillCreateSource() {
    var sel = $('createSource');
    if (!sel || sel.options.length) return;
    sel.innerHTML = CREATE_SOURCES.map(function (s) {
      return '<option value="' + esc(s.id) + '">' + esc(s.label) + '</option>';
    }).join('');
  }
  function setCreateLink(src) {
    var a = $('createGithub');
    if (!a) return;
    if (src && src.github) {
      a.href = GH_BLOB + src.github;
      a.textContent = 'View ' + src.github.replace(/^src\//, '') + ' on GitHub';
    } else {
      a.href = GH_BLOB + 'docs/pack-format.md';
      a.textContent = 'Pack format on GitHub';
    }
  }
  function appendRulesNote(el, manifest) {
    if (!manifest || typeof manifest !== 'object') return;
    var rules = manifest.rules;
    if (manifest.remote) {
      var remote = document.createElement('span');
      remote.className = 'warn';
      remote.textContent = 'This file uses a remote host cache (the WordleBot lists). Try it will not load that. A custom pack can use an https URL of a plain text word list, or an array of words. ';
      el.appendChild(remote);
    }
    if (typeof rules === 'string' && rules.indexOf('script:') === 0) {
      var rel = rules.slice('script:'.length);
      el.appendChild(document.createTextNode('This JSON points at a rules module (' + rel + '). That file is not inside the JSON, and this editor cannot run JavaScript you paste. '));
      if (Pack.shippedRuleScript(rel)) {
        var a = document.createElement('a');
        a.href = GH_BLOB + 'src/packs/' + rel;
        a.textContent = 'View ' + rel + ' on GitHub';
        el.appendChild(a);
        el.appendChild(document.createTextNode('. Try it loads only that shipped file. Any other script path is rejected.'));
      } else {
        el.appendChild(document.createTextNode('This page will not run that path. Try it only loads rules/wordle.js or rules/dungleon.js.'));
      }
      return;
    }
    if (!manifest.remote) {
      el.appendChild(document.createTextNode('Built-in rules (' + (rules || 'builtin:wordle') + '). No extra JavaScript is loaded. A pack you invent here stays JSON-only.'));
    }
  }
  function showCreateRules() {
    var el = $('createRules');
    if (!el) return;
    el.textContent = '';
    if (viewedManifest) appendRulesNote(el, viewedManifest);
  }
  function editorObject() {
    var text = $('createJson') ? $('createJson').value : '';
    if (!String(text).trim()) return { error: 'The editor is empty.' };
    try { return { value: JSON.parse(text) }; }
    catch (err) { return { error: 'Not valid JSON (' + (err && err.message ? err.message : 'parse error') + ').' }; }
  }
  function showValidation(result) {
    var ul = $('createErrors');
    if (!ul) return;
    ul.textContent = '';
    var items = (result.errors || []).map(function (e) { return { path: e.path, message: e.message, warn: false }; })
      .concat((result.warnings || []).map(function (w) { return { path: w.path, message: w.message, warn: true }; }));
    if (!items.length) {
      var ok = document.createElement('li');
      ok.className = 'ok';
      ok.textContent = 'Valid pack.';
      ul.appendChild(ok);
      return;
    }
    items.forEach(function (item) {
      var li = document.createElement('li');
      li.className = item.warn ? 'warn' : 'bad';
      var code = document.createElement('code');
      code.textContent = item.path || '(pack)';
      li.appendChild(code);
      li.appendChild(document.createTextNode(' — ' + item.message));
      ul.appendChild(li);
    });
  }
  function syncCreateVariants(manifest) {
    var label = $('createVariantLabel');
    var sel = $('createVariant');
    if (!label || !sel) return;
    var variants = manifest && Array.isArray(manifest.variants) ? manifest.variants : [];
    if (variants.length < 2) { label.hidden = true; sel.innerHTML = ''; return; }
    label.hidden = false;
    var prev = sel.value;
    sel.innerHTML = variants.map(function (v, i) {
      var id = v && v.id ? String(v.id) : String(i);
      var name = v && v.name ? String(v.name) : id;
      return '<option value="' + esc(id) + '">' + esc(name) + '</option>';
    }).join('');
    if (prev) sel.value = prev;
  }
  function validateEditor() {
    var parsed = editorObject();
    if (parsed.error) {
      showValidation({ errors: [{ path: '(json)', message: parsed.error }], warnings: [] });
      showCreateRules(null);
      syncCreateVariants(null);
      return null;
    }
    var result = Pack.validateManifest(parsed.value);
    showValidation(result);
    showCreateRules();
    syncCreateVariants(parsed.value);
    return result.ok ? parsed.value : null;
  }
  function updateGutter() {
    var area = $('createJson');
    var gutter = $('createGutter');
    if (!area || !gutter) return;
    var n = Math.max(1, area.value.split('\n').length);
    var lines = [];
    var i;
    for (i = 1; i <= n; i++) lines.push(String(i));
    gutter.textContent = lines.join('\n');
    gutter.scrollTop = area.scrollTop;
  }
  var createTimer = null;
  function onCreateEdit() {
    updateGutter();
    if (createTimer) clearTimeout(createTimer);
    createTimer = setTimeout(function () { createTimer = null; validateEditor(); }, 120);
  }
  var spriteEdit = {
    url: '', objectUrl: '', cellWidth: 32, cellHeight: 32, columns: 1, rows: 1,
    offsetX: 0, offsetY: 0, gapX: 0, gapY: 0,
    keyboardSource: 'auto', tilesSource: 'auto',
    map: {}, images: {}, labels: {}, cells: [], tokens: [], selectedCell: null
  };

  function spriteSheetSpec() {
    return {
      columns: spriteEdit.columns, rows: spriteEdit.rows,
      cellWidth: spriteEdit.cellWidth, cellHeight: spriteEdit.cellHeight,
      offsetX: spriteEdit.offsetX, offsetY: spriteEdit.offsetY,
      gapX: spriteEdit.gapX, gapY: spriteEdit.gapY
    };
  }
  function readSpriteForm() {
    function num(id, fallback) {
      var n = parseFloat($(id) && $(id).value);
      return isFinite(n) ? n : fallback;
    }
    if ($('spriteUrl')) spriteEdit.url = ($('spriteUrl').value || '').trim();
    spriteEdit.cellWidth = Math.max(1, num('spriteCellW', 32));
    spriteEdit.cellHeight = Math.max(1, num('spriteCellH', 32));
    spriteEdit.columns = Math.max(1, Math.floor(num('spriteCols', 1)));
    spriteEdit.rows = Math.max(1, Math.floor(num('spriteRows', 1)));
    spriteEdit.offsetX = Math.max(0, num('spriteOffX', 0));
    spriteEdit.offsetY = Math.max(0, num('spriteOffY', 0));
    spriteEdit.gapX = Math.max(0, num('spriteGapX', 0));
    spriteEdit.gapY = Math.max(0, num('spriteGapY', 0));
    if ($('spriteKeySource')) spriteEdit.keyboardSource = $('spriteKeySource').value || 'auto';
    if ($('spriteTileSource')) spriteEdit.tilesSource = $('spriteTileSource').value || 'auto';
  }
  function writeSpriteForm() {
    if (!$('spriteUrl')) return;
    $('spriteUrl').value = spriteEdit.url || '';
    $('spriteCellW').value = spriteEdit.cellWidth;
    $('spriteCellH').value = spriteEdit.cellHeight;
    $('spriteCols').value = spriteEdit.columns;
    $('spriteRows').value = spriteEdit.rows;
    $('spriteOffX').value = spriteEdit.offsetX;
    $('spriteOffY').value = spriteEdit.offsetY;
    $('spriteGapX').value = spriteEdit.gapX;
    $('spriteGapY').value = spriteEdit.gapY;
    $('spriteKeySource').value = spriteEdit.keyboardSource;
    $('spriteTileSource').value = spriteEdit.tilesSource;
  }
  function manifestAlphabet(manifest) {
    if (!manifest) return [];
    return Pack.alphabetTokens({
      alphabet: manifest.alphabet,
      delimiter: manifest.delimiter || 'none',
      caseInsensitive: manifest.caseInsensitive !== false
    });
  }
  function loadSpriteEditor(manifest) {
    var app = (manifest && (manifest.appearance || manifest.images)) || {};
    var sheet = app.sheet || {};
    spriteEdit.url = typeof sheet.url === 'string' ? sheet.url : '';
    spriteEdit.cellWidth = sheet.cellWidth || sheet.width || 32;
    spriteEdit.cellHeight = sheet.cellHeight || sheet.height || spriteEdit.cellWidth;
    spriteEdit.columns = sheet.columns || 1;
    spriteEdit.rows = sheet.rows || 1;
    spriteEdit.offsetX = sheet.offsetX || 0;
    spriteEdit.offsetY = sheet.offsetY || 0;
    spriteEdit.gapX = sheet.gapX || 0;
    spriteEdit.gapY = sheet.gapY || 0;
    spriteEdit.keyboardSource = (app.keyboard && app.keyboard.source) || 'auto';
    spriteEdit.tilesSource = (app.tiles && app.tiles.source) || 'auto';
    spriteEdit.cells = Array.isArray(sheet.cells) ? sheet.cells.map(function (c) { return String(c); }) : [];
    spriteEdit.map = {};
    spriteEdit.images = {};
    spriteEdit.labels = {};
    spriteEdit.tokens = manifestAlphabet(manifest);
    spriteEdit.selectedCell = null;
    var ents = app.entities || {};
    Object.keys(ents).forEach(function (tok) {
      var e = ents[tok];
      if (!e || typeof e !== 'object') return;
      if (typeof e.label === 'string') spriteEdit.labels[tok] = e.label;
      if (typeof e.image === 'string') spriteEdit.images[tok] = e.image;
      var cell = Pack.spriteCell(e.sprite, spriteEdit.columns || 1);
      if (cell) {
        var index = cell.index != null ? cell.index : cell.row * spriteEdit.columns + cell.col;
        spriteEdit.map[index] = tok;
      }
      if (spriteEdit.tokens.indexOf(tok) < 0) spriteEdit.tokens.push(tok);
    });
    if (spriteEdit.objectUrl) {
      URL.revokeObjectURL(spriteEdit.objectUrl);
      spriteEdit.objectUrl = '';
    }
    writeSpriteForm();
    var img = $('spriteSheetImg');
    if (img) {
      img.onload = drawSpriteGrid;
      img.onerror = function () {
        if ($('spriteStatus')) $('spriteStatus').textContent = 'That sheet did not load.';
      };
      img.src = spriteEdit.url || '';
      if (img.complete) drawSpriteGrid();
    }
    renderSpriteTokens();
    renderSpriteMapTable();
    renderSpriteImageTable();
    renderSpritePreview();
  }
  function drawSpriteGrid() {
    readSpriteForm();
    var img = $('spriteSheetImg');
    var grid = $('spriteGrid');
    if (!img || !grid) return;
    grid.textContent = '';
    var nw = img.naturalWidth || 0;
    var nh = img.naturalHeight || 0;
    if (!nw || !nh) {
      if ($('spriteStatus') && !img.getAttribute('src')) $('spriteStatus').textContent = 'Load a sheet to see the grid.';
      return;
    }
    var maxW = 720;
    var scale = nw > maxW ? maxW / nw : 1;
    img.style.width = Math.round(nw * scale) + 'px';
    img.style.height = Math.round(nh * scale) + 'px';
    var cols = spriteEdit.columns;
    var rows = spriteEdit.rows;
    var i, col, row, x, y, btn, cap;
    for (i = 0; i < cols * rows; i++) {
      col = i % cols;
      row = Math.floor(i / cols);
      x = spriteEdit.offsetX + col * (spriteEdit.cellWidth + spriteEdit.gapX);
      y = spriteEdit.offsetY + row * (spriteEdit.cellHeight + spriteEdit.gapY);
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sprite-cell' + (spriteEdit.selectedCell === i ? ' on' : '');
      btn.style.left = (x * scale) + 'px';
      btn.style.top = (y * scale) + 'px';
      btn.style.width = Math.max(8, spriteEdit.cellWidth * scale) + 'px';
      btn.style.height = Math.max(8, spriteEdit.cellHeight * scale) + 'px';
      btn.setAttribute('data-cell', String(i));
      btn.appendChild(document.createTextNode(String(i)));
      if (spriteEdit.map[i]) {
        cap = document.createElement('span');
        cap.textContent = spriteEdit.map[i];
        btn.appendChild(cap);
      }
      grid.appendChild(btn);
    }
    if ($('spriteStatus')) {
      if (spriteEdit.selectedCell == null) {
        $('spriteStatus').textContent = 'Click a numbered cell, then a token. ' + cols + ' by ' + rows + ' cells.';
      } else {
        var code = spriteEdit.cells[spriteEdit.selectedCell] || '';
        var tok = spriteEdit.map[spriteEdit.selectedCell] || '';
        $('spriteStatus').textContent = 'Cell ' + spriteEdit.selectedCell + (code ? ' (' + code + ')' : '') +
          (tok ? ' is ' + tok : ' is not mapped') + '. Click a token to assign it.';
      }
    }
  }
  function assignCell(index, token) {
    var prev;
    Object.keys(spriteEdit.map).forEach(function (k) {
      if (spriteEdit.map[k] === token) delete spriteEdit.map[k];
    });
    if (token) spriteEdit.map[index] = token;
    else delete spriteEdit.map[index];
    spriteEdit.selectedCell = index;
    drawSpriteGrid();
    renderSpriteTokens();
    renderSpriteMapTable();
    renderSpritePreview();
  }
  function renderSpriteTokens() {
    var box = $('spriteTokens');
    if (!box) return;
    box.textContent = '';
    spriteEdit.tokens.forEach(function (tok) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost mini' + (spriteEdit.selectedCell != null && spriteEdit.map[spriteEdit.selectedCell] === tok ? ' on' : '');
      b.textContent = (spriteEdit.labels[tok] ? spriteEdit.labels[tok] + ' ' : '') + tok;
      b.setAttribute('data-token', tok);
      box.appendChild(b);
    });
  }
  function renderSpriteMapTable() {
    var table = $('spriteMapTable');
    if (!table || !table.tBodies[0]) return;
    var body = table.tBodies[0];
    body.textContent = '';
    var n = spriteEdit.columns * spriteEdit.rows;
    var i, tr, td, sel, opt;
    for (i = 0; i < n; i++) {
      tr = document.createElement('tr');
      td = document.createElement('td');
      td.textContent = String(i);
      tr.appendChild(td);
      td = document.createElement('td');
      td.textContent = spriteEdit.cells[i] || '';
      tr.appendChild(td);
      td = document.createElement('td');
      sel = document.createElement('select');
      sel.setAttribute('data-map', String(i));
      opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '—';
      sel.appendChild(opt);
      spriteEdit.tokens.forEach(function (tok) {
        opt = document.createElement('option');
        opt.value = tok;
        opt.textContent = tok;
        if (spriteEdit.map[i] === tok) opt.selected = true;
        sel.appendChild(opt);
      });
      td.appendChild(sel);
      tr.appendChild(td);
      body.appendChild(tr);
    }
  }
  function renderSpriteImageTable() {
    var table = $('spriteImageTable');
    if (!table || !table.tBodies[0]) return;
    var body = table.tBodies[0];
    body.textContent = '';
    spriteEdit.tokens.forEach(function (tok) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.textContent = tok;
      tr.appendChild(td);
      td = document.createElement('td');
      var lab = document.createElement('input');
      lab.type = 'text';
      lab.value = spriteEdit.labels[tok] || '';
      lab.setAttribute('data-label', tok);
      td.appendChild(lab);
      tr.appendChild(td);
      td = document.createElement('td');
      var url = document.createElement('input');
      url.type = 'text';
      url.value = spriteEdit.images[tok] || '';
      url.spellcheck = false;
      url.setAttribute('data-image', tok);
      td.appendChild(url);
      tr.appendChild(td);
      td = document.createElement('td');
      if (spriteEdit.images[tok] && Pack.isPresentationUrl(spriteEdit.images[tok])) {
        var thumb = document.createElement('img');
        thumb.className = 'thumb';
        thumb.alt = '';
        thumb.src = spriteEdit.images[tok];
        td.appendChild(thumb);
      }
      tr.appendChild(td);
      body.appendChild(tr);
    });
  }
  function faceFor(tok, source) {
    var image = spriteEdit.images[tok];
    var index = null;
    Object.keys(spriteEdit.map).forEach(function (k) { if (spriteEdit.map[k] === tok) index = +k; });
    var src = spriteEdit.objectUrl || spriteEdit.url;
    var wantImage = source === 'image' || (source !== 'sprite' && image);
    if (source === 'sprite') wantImage = false;
    if (wantImage && image && Pack.isPresentationUrl(image)) {
      var photo = document.createElement('img');
      photo.className = 'entity-photo';
      photo.alt = '';
      photo.src = image;
      return photo;
    }
    if (index != null && src && (source === 'sprite' || source === 'auto' || source === 'image')) {
      if (source === 'image' && wantImage) return document.createTextNode(tok);
      var cols = spriteEdit.columns || 1;
      var spec = spriteSheetSpec();
      var origin = Pack.cellOrigin(spec, index % cols, Math.floor(index / cols));
      var m = Pack.sheetMetrics(spec);
      var box = document.createElement('span');
      box.className = 'entity-sprite';
      box.style.cssText = '--cellw:' + m.cellWidth + ';--cellh:' + m.cellHeight +
        ';--sheetw:' + m.width + ';--sheeth:' + m.height + ';--px:' + origin.x + ';--py:' + origin.y;
      var img = document.createElement('img');
      img.className = 'entity-img';
      img.alt = '';
      img.src = src;
      box.appendChild(img);
      return box;
    }
    return document.createTextNode(tok);
  }
  function renderSpritePreview() {
    readSpriteForm();
    var kb = $('spritePreviewKb');
    var tiles = $('spritePreviewTiles');
    if (!kb || !tiles) return;
    kb.textContent = '';
    tiles.textContent = '';
    var row = document.createElement('div');
    row.className = 'key-row';
    var sample = document.createElement('span');
    sample.className = 'tiles glyph';
    spriteEdit.tokens.slice(0, 12).forEach(function (tok) {
      var key = document.createElement('button');
      key.type = 'button';
      key.className = 'key art';
      key.appendChild(faceFor(tok, spriteEdit.keyboardSource));
      var cap = document.createElement('span');
      cap.className = 'key-cap';
      cap.textContent = tok;
      key.appendChild(cap);
      row.appendChild(key);
      var tile = document.createElement('span');
      tile.className = 'tile e';
      tile.appendChild(faceFor(tok, spriteEdit.tilesSource));
      sample.appendChild(tile);
    });
    kb.appendChild(row);
    tiles.appendChild(sample);
  }
  function applySpriteToEditor() {
    readSpriteForm();
    var parsed = editorObject();
    var msg = $('spriteMsg');
    if (parsed.error) {
      if (msg) msg.textContent = parsed.error;
      return;
    }
    var manifest = parsed.value;
    var app = (manifest.appearance && typeof manifest.appearance === 'object') ? manifest.appearance : {};
    app.keyboard = { source: spriteEdit.keyboardSource };
    app.tiles = { source: spriteEdit.tilesSource };
    if (spriteEdit.url && !Pack.isPresentationUrl(spriteEdit.url)) {
      if (msg) msg.textContent = 'The sheet URL must be http(s) or a relative path. A local file is preview-only.';
      return;
    }
    if (spriteEdit.url) {
      app.sheet = {
        url: spriteEdit.url,
        cellWidth: spriteEdit.cellWidth,
        cellHeight: spriteEdit.cellHeight,
        columns: spriteEdit.columns,
        rows: spriteEdit.rows,
        offsetX: spriteEdit.offsetX,
        offsetY: spriteEdit.offsetY,
        gapX: spriteEdit.gapX,
        gapY: spriteEdit.gapY
      };
      if (spriteEdit.cells.length) app.sheet.cells = spriteEdit.cells.slice();
    }
    var entities = (app.entities && typeof app.entities === 'object') ? app.entities : {};
    var badTok = null;
    spriteEdit.tokens.forEach(function (tok) {
      if (spriteEdit.images[tok] && !Pack.isPresentationUrl(spriteEdit.images[tok])) badTok = tok;
    });
    if (badTok) {
      if (msg) msg.textContent = 'Image for ' + badTok + ' must be http(s) or a relative path.';
      return;
    }
    spriteEdit.tokens.forEach(function (tok) {
      var ent = (entities[tok] && typeof entities[tok] === 'object') ? entities[tok] : {};
      if (spriteEdit.labels[tok]) ent.label = spriteEdit.labels[tok];
      if (spriteEdit.images[tok]) ent.image = spriteEdit.images[tok];
      delete ent.sprite;
      entities[tok] = ent;
    });
    Object.keys(spriteEdit.map).forEach(function (k) {
      var tok = spriteEdit.map[k];
      if (!tok) return;
      entities[tok] = entities[tok] || {};
      entities[tok].sprite = { index: +k };
    });
    app.entities = entities;
    manifest.appearance = app;
    $('createJson').value = JSON.stringify(manifest, null, 2) + '\n';
    onCreateEdit();
    if (msg && !(msg.textContent && msg.textContent.indexOf('must be') >= 0)) msg.textContent = 'Wrote appearance into the editor.';
  }
  function showCreateFile(text) {
    createFileText = text || '';
    var pre = $('createSourceView');
    if (pre) {
      pre.textContent = createFileText || '(empty)';
      var at = createFileText.indexOf('"appearance"');
      if (at >= 0) pre.scrollTop = Math.max(0, (createFileText.slice(0, at).split('\n').length - 2) * 19);
    }
  }
  function loadCreateSource() {
    fillCreateSource();
    var src = createSourceById($('createSource').value);
    setCreateLink(src);
    if (src.template) {
      viewedManifest = templateManifest();
      showCreateFile(templateText());
      showCreateRules();
      loadSpriteEditor(viewedManifest);
      return;
    }
    var pre = $('createSourceView');
    if (pre) pre.textContent = 'Loading ' + src.file + '…';
    fetch(src.file).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      if (createSourceById($('createSource').value).id !== src.id) return;
      showCreateFile(text);
      try { viewedManifest = JSON.parse(text); } catch (e) { viewedManifest = null; }
      showCreateRules();
      if (viewedManifest) loadSpriteEditor(viewedManifest);
      if (src.id === 'dungleon' && $('createJson') && (!$('createJson').value.trim() || $('createJson').value.indexOf('"id": "my-game"') >= 0)) {
        $('createJson').value = text;
        onCreateEdit();
      }
    }).catch(function (err) {
      showCreateFile('Could not load ' + src.file + ' (' + (err && err.message ? err.message : 'failed') + ').');
    });
  }
  function openCreate() {
    fillCreateSource();
    if (!createLoaded) {
      createLoaded = true;
      if ($('createSource')) $('createSource').value = 'dungleon';
      if ($('createJson') && !$('createJson').value) $('createJson').value = templateText();
      loadCreateSource();
      onCreateEdit();
      renderCreateSaved();
    }
  }
  function renderCreateSaved() {
    var box = $('createSaved');
    if (!box) return;
    var jp = jsonPacks();
    var keys = Object.keys(jp);
    if (!keys.length) {
      box.textContent = '';
      var none = document.createElement('span');
      none.className = 'muted small';
      none.textContent = 'None yet. Try it saves one here and in Game setup.';
      box.appendChild(none);
      return;
    }
    box.textContent = '';
    keys.forEach(function (key) {
      var rec = jp[key] || {};
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost mini';
      btn.textContent = 'Delete ' + (rec.name || key);
      btn.addEventListener('click', function () {
        deleteJsonPack(key);
        if (packId === 'json:' + key) { packId = 'nyt'; fillPackSel(); loadPack('nyt', false); }
        else fillPackSel();
      });
      box.appendChild(btn);
    });
  }
  function chosenVariant(manifest) {
    var variants = manifest.variants || [];
    if (!variants.length) {
      return {
        id: manifest.id,
        name: manifest.name,
        length: manifest.length,
        knownSolutions: manifest.knownSolutions,
        guessList: manifest.guessList,
        guessMode: manifest.guessMode,
        openers: manifest.openers
      };
    }
    var want = $('createVariant') && !$('createVariantLabel').hidden ? $('createVariant').value : '';
    var i;
    for (i = 0; i < variants.length; i++) if (variants[i] && variants[i].id === want) return variants[i];
    return variants[0];
  }
  function tryCreatePack() {
    var msg = $('createMsg');
    var manifest = validateEditor();
    if (!manifest) {
      if (msg) msg.textContent = 'Fix the errors above before trying this pack.';
      return;
    }
    var variant = chosenVariant(manifest);
    if (msg) msg.textContent = 'Loading lists…';
    var answersP = listText(variant.knownSolutions);
    var guessesP = variant.guessList != null ? listText(variant.guessList) : Promise.resolve('');
    Promise.all([answersP, guessesP]).then(function (parts) {
      var pack = Pack.normalize(manifest, variant);
      return loadShippedRules(pack).then(function () {
        return parts;
      });
    }).then(function (parts) {
      var jp = jsonPacks();
      jp[manifest.id] = {
        name: manifest.name,
        manifest: manifest,
        variantId: variant.id || manifest.id,
        answers: parts[0],
        guesses: parts[1]
      };
      localStorage.setItem(LS_JSON, JSON.stringify(jp));
      renderCreateSaved();
      packId = 'json:' + manifest.id;
      fillPackSel();
      if (msg) msg.textContent = 'Saved “' + manifest.name + '” in this browser. It is selected under Game setup.';
      applyPage('both');
      return loadPack('json:' + manifest.id, false, true);
    }).catch(function (err) {
      var why = (err && err.message) ? err.message : 'the pack did not load';
      if (why === 'Failed to fetch' || why === 'Load failed') why = 'the browser could not fetch that list (' + why + ')';
      if (msg) msg.textContent = 'Could not try this pack: ' + why;
    });
  }
  function downloadCreateJson() {
    var text = $('createJson').value;
    var name = 'game.json';
    try {
      var obj = JSON.parse(text);
      if (obj && typeof obj.id === 'string' && /^[A-Za-z0-9_-]+$/.test(obj.id)) name = obj.id + '.json';
    } catch (e) {}
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }

  if ($('keyboard')) {
    $('keyboard').addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) e.preventDefault();
    });
    $('keyboard').addEventListener('click', function (e) {
      var b = e.target.closest('[data-key]');
      if (!b) return;
      onKeyPress(b.getAttribute('data-key'));
    });
  }
  if ($('keyboardToggle')) $('keyboardToggle').addEventListener('click', function () {
    cfg.keyboardOpen = !keyboardIsOpen();
    syncKeyboardOpen();
    saveState();
  });
  if ($('cfgCake')) $('cfgCake').addEventListener('change', function () {
    cfg.cake = this.checked;
    saveState();
    if (cakePackActive()) remountActivePack();
    else syncCakeOption();
  });
  if ($('cfgImages')) $('cfgImages').addEventListener('change', function () {
    cfg.images = this.checked;
    renderClues();
    renderPreview();
    renderRemaining();
    renderKeyboard();
    if (lastTop && lastTop.length) renderSuggestions(lastTop);
    renderOpenerPicks();
    renderOpenerTable(openerWords);
    renderTree();
    if (gauntletView) renderGauntletBoard(gauntletView);
    if ($('bdRows') && $('bdRows').dataset.guess) analyze($('bdRows').dataset.guess, false);
    saveState();
  });
  GUESS_FIELDS.forEach(function (id) {
    var el = $(id);
    if (!el) return;
    el.addEventListener('focus', function () { keyTarget = id; markKeyTarget(); });
  });
  function artHost(node) {
    return node && node.closest ? node.closest('.tile, .mini-tile, .key') : null;
  }
  document.addEventListener('load', function (e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('entity-img')) return;
    var host = artHost(t);
    if (host) host.classList.add('art-ready');
  }, true);
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('entity-img')) return;
    var host = artHost(t);
    if (!host) return;
    host.classList.add('art-failed');
    host.classList.remove('art-ready');
    var letter = host.querySelector('.entity-letter');
    if (letter) letter.removeAttribute('aria-hidden');
  }, true);
  function settleArt(root) {
    if (!document.querySelectorAll) return;
    var imgs = (root || document).querySelectorAll('img.entity-img');
    Array.prototype.forEach.call(imgs, function (img) {
      if (!img.complete) return;
      var host = artHost(img);
      if (!host) return;
      if (img.naturalWidth > 0) host.classList.add('art-ready');
      else {
        host.classList.add('art-failed');
        host.classList.remove('art-ready');
      }
    });
  }
  if (window.MutationObserver) {
    new MutationObserver(function () { settleArt(document); }).observe(document.body, { childList: true, subtree: true });
  }

  if ($('createSource')) $('createSource').addEventListener('change', loadCreateSource);
  if ($('createCopy')) $('createCopy').addEventListener('click', function () {
    if (!$('createJson')) return;
    $('createJson').value = createFileText || templateText();
    onCreateEdit();
    $('createJson').focus();
  });
  if ($('createJson')) {
    $('createJson').addEventListener('input', onCreateEdit);
    $('createJson').addEventListener('scroll', function () {
      if ($('createGutter')) $('createGutter').scrollTop = $('createJson').scrollTop;
    });
  }
  if ($('createTry')) $('createTry').addEventListener('click', tryCreatePack);
  if ($('createDownload')) $('createDownload').addEventListener('click', downloadCreateJson);
  if ($('spriteGrid')) $('spriteGrid').addEventListener('click', function (e) {
    var b = e.target.closest('[data-cell]');
    if (!b) return;
    spriteEdit.selectedCell = +b.getAttribute('data-cell');
    drawSpriteGrid();
    renderSpriteTokens();
  });
  if ($('spriteTokens')) $('spriteTokens').addEventListener('click', function (e) {
    var b = e.target.closest('[data-token]');
    if (!b || spriteEdit.selectedCell == null) return;
    assignCell(spriteEdit.selectedCell, b.getAttribute('data-token'));
  });
  if ($('spriteMapTable')) $('spriteMapTable').addEventListener('change', function (e) {
    var sel = e.target.closest('select[data-map]');
    if (!sel) return;
    assignCell(+sel.getAttribute('data-map'), sel.value);
  });
  if ($('spriteImageTable')) $('spriteImageTable').addEventListener('input', function (e) {
    var lab = e.target.getAttribute('data-label');
    var img = e.target.getAttribute('data-image');
    if (lab != null) spriteEdit.labels[lab] = e.target.value;
    if (img != null) spriteEdit.images[img] = e.target.value.trim();
    renderSpritePreview();
  });
  ['spriteCellW', 'spriteCellH', 'spriteCols', 'spriteRows', 'spriteOffX', 'spriteOffY', 'spriteGapX', 'spriteGapY', 'spriteKeySource', 'spriteTileSource'].forEach(function (id) {
    if (!$(id)) return;
    $(id).addEventListener('input', function () { readSpriteForm(); drawSpriteGrid(); renderSpritePreview(); });
    $(id).addEventListener('change', function () { readSpriteForm(); drawSpriteGrid(); renderSpriteMapTable(); renderSpritePreview(); });
  });
  if ($('spriteUrl')) $('spriteUrl').addEventListener('change', function () {
    readSpriteForm();
    if (!spriteEdit.objectUrl && $('spriteSheetImg')) $('spriteSheetImg').src = spriteEdit.url;
    renderSpritePreview();
  });
  if ($('spriteFile')) $('spriteFile').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    if (spriteEdit.objectUrl) URL.revokeObjectURL(spriteEdit.objectUrl);
    spriteEdit.objectUrl = URL.createObjectURL(f);
    if ($('spriteSheetImg')) $('spriteSheetImg').src = spriteEdit.objectUrl;
    if ($('spriteStatus')) $('spriteStatus').textContent = 'Local sheet loaded for preview only. It is not saved in the JSON.';
    renderSpritePreview();
  });
  if ($('spriteApply')) $('spriteApply').addEventListener('click', applySpriteToEditor);
  if ($('createImport')) $('createImport').addEventListener('change', function () {
    var input = this;
    var f = input.files && input.files[0];
    if (!f) return;
    f.text().then(function (t) {
      $('createJson').value = t;
      onCreateEdit();
      input.value = '';
      if ($('createMsg')) $('createMsg').textContent = 'Imported ' + f.name + ' into the editor. Nothing was uploaded.';
    }).catch(function () {
      if ($('createMsg')) $('createMsg').textContent = 'Could not read that file.';
    });
  });

  function saveState() {
    try {
      var floors = gauntlet.floors.map(function (f) {
        return {
          clues: f.clues.map(function (c) { return { key: c.key, digits: c.digits }; }),
          solution: f.solution || ''
        };
      });
      localStorage.setItem(LS_STATE, JSON.stringify({
        packId: packId, cfg: cfg,
        clues: floors[0] ? floors[0].clues : [],
        gauntlet: { mode: gauntlet.mode, focus: gauntlet.focus, floors: floors }
      }));
    } catch (e) {}
  }
  bindGauntletBoard();
  if ($('gauntletModes')) $('gauntletModes').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-gauntlet]');
    if (!b || !gauntletSupported()) return;
    var next = b.getAttribute('data-gauntlet');
    if (next !== 'normal' && next !== 'gauntlet') return;
    if (next === gauntlet.mode) return;
    gauntlet.mode = next;
    syncGauntletMode();
    refresh();
  });

  function init() {
    var st = null; try { st = JSON.parse(localStorage.getItem(LS_STATE) || 'null'); } catch (e) {}
    if (st && st.cfg) {
        ['mode', 'hard', 'ansOnly', 'max', 'top', 'notation', 'valid', 'layer', 'guessMode', 'page', 'guarantee', 'steps', 'stepsTouched', 'treePolicy', 'nytAnswers', 'nytGuesses', 'images', 'keyboardOpen', 'cake'].forEach(function (k) {
        if (st.cfg[k] !== undefined) cfg[k] = st.cfg[k];
      });
      if (!st.cfg.guessMode) cfg.guessMode = inferGuessMode();
    }
    nytWant.answers = cfg.nytAnswers || 'with-ed';
    nytWant.guesses = cfg.nytGuesses || 'all';
    if ($('nytAnswers')) $('nytAnswers').value = nytWant.answers;
    if ($('nytGuesses')) $('nytGuesses').value = nytWant.guesses;
    var pid = 'nyt';
    if (st && st.packId) {
      if (st.packId.indexOf('saved:') === 0 && savedPacks()[st.packId.slice(6)]) pid = st.packId;
      else if (st.packId.indexOf('json:') === 0 && jsonPacks()[st.packId.slice(5)]) pid = st.packId;
      else if (BUILTIN.some(function (b) { return b.id === st.packId && !b.blank; })) pid = st.packId;
    }
    packId = pid; fillPackSel(); writeCfgToUI();
    loadPack(pid, false).then(function () {
      if (!engine) return;
      if (st && st.gauntlet && Array.isArray(st.gauntlet.floors) && st.gauntlet.floors.length) {
        ensureGauntletFloors(Math.max(gauntletFloors(), st.gauntlet.floors.length));
        st.gauntlet.floors.forEach(function (f, i) {
          if (!gauntlet.floors[i]) return;
          restoreClueList(gauntlet.floors[i].clues, f && f.clues);
          gauntlet.floors[i].solution = f && typeof f.solution === 'string' ? f.solution : '';
        });
        if (!gauntlet.floors[0].clues.length && st.clues && st.clues.length) restoreClueList(gauntlet.floors[0].clues, st.clues);
        gauntlet.focus = st.gauntlet.focus | 0;
        gauntlet.mode = st.gauntlet.mode === 'gauntlet' ? 'gauntlet' : 'normal';
      } else if (st && st.clues && st.clues.length) {
        restoreClueList(gauntlet.floors[0].clues, st.clues);
      }
      if (gauntlet.focus < 0 || gauntlet.focus >= gauntlet.floors.length) gauntlet.focus = 0;
      syncGauntletMode();
      refresh();
    });
  }
  init();
})();
