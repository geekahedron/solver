/* Wordle-style Solver — UI. Pools, clues, and scoring go through SolverEngine. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var Core = window.SolverCore;
  var Pack = window.SolverPack;
  var Renderers = window.SolverRenderers;
  var TreeStatus = window.SolverTreeStatus;
  if (!TreeStatus) throw new Error('tree-status.js failed to load');
  var LS_KEY = 'geek-solver-packs-v1', LS_STATE = 'geek-solver-state-v1';

  var BUILTIN = [
    { id: 'en5', name: 'Wordle — English 5-letter (built-in)', variant: 'wordle-en-5' },
    { id: 'en4', name: 'English 4-letter (built-in)', variant: 'wordle-en-4' },
    { id: 'en6', name: 'English 6-letter (built-in)', variant: 'wordle-en-6' },
    { id: 'en7', name: 'English 7-letter (built-in)', variant: 'wordle-en-7' },
    { id: 'en8', name: 'English 8-letter (built-in)', variant: 'wordle-en-8' },
    { id: 'nyt', name: 'Wordle — NYT WordleBot lists (live)', manifest: 'packs/wordle-nyt.json', variant: 'wordle-nyt', remote: true },
    { id: 'dungleon', name: 'Dungleon', manifest: 'packs/dungleon.json', variant: 'dungleon' },
    { id: 'blank', name: 'Custom — paste / upload your own lists', blank: true },
    { id: 'digits', name: 'Custom digits (0-9) — paste your list', blank: true, preset: { L: 5, alpha: '0123456789' } },
    { id: 'tokens', name: 'Custom tokens (cards, emoji…) — paste your list', blank: true, preset: { tok: true, alpha: '', ci: false } }
  ];

  var cfg = { L: 5, alpha: 'abcdefghijklmnopqrstuvwxyz', ci: true, tok: false, rule: 'wordle', valid: 'both',
    mode: 'avg', hard: 'off', ansOnly: false, max: 12000, top: 15, notation: 'GYB',
    layer: 'known', guessMode: 'dictionary', page: 'both',
    guarantee: false, steps: 6, stepsTouched: false, treePolicy: 'worst',
    nytAnswers: 'with-ed', nytGuesses: 'all' };
  var packId = 'en5';
  var readyPackId = null;
  var keepPackWarn = false;
  var packWarn = '';
  var nytWant = { answers: 'with-ed', guesses: 'all' };
  var nytLoaded = null;
  var nytCache = Object.create(null);
  var nytFilling = false;
  var packGuessDefault = null;
  var engine = null;
  var packPhase = 'idle';
  var packError = '';
  var packGen = 0;
  var clues = [];
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
  function tilesHTML(syms, digits, opts) {
    var id = engine ? engine.pack.tokenRenderer : 'tiles/letters';
    opts = Object.assign({}, opts || {});
    if (engine && engine.pack) opts.marks = engine.pack.clueAlphabet;
    return Renderers.tiles(id, syms, digits, opts);
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
    var shown = idxs.slice(0, 3000).map(function (i) { return esc(engine.keys[i]); });
    return shown.map(function (w) { return '<div>' + w + '</div>'; }).join('') +
      (idxs.length > 3000 ? '<div class="muted">… +' + (idxs.length - 3000) + ' more</div>' : '');
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
    if ($('remDetails').open) $('remList').innerHTML = listHTML(remKnown);
    if ($('remTheo').open) $('remTheoList').innerHTML = listHTML(remTheo);
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
      return '<tr data-key="' + esc(k) + '"' + (k === selectedKey ? ' class="sel"' : '') + '><td>' + (i + 1) + '</td><td>' + esc(k) + '</td><td>' + stepsText(s) + '</td><td>' + fmt(s.exp, 2) +
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
        words.slice(0, 2000).map(function (w) { return '<div>' + esc(w) + '</div>'; }).join('') + (words.length > 2000 ? '<div class="muted">…</div>' : '') + '</div></details>';
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
  $('clearBtn').addEventListener('click', function () { clues = []; refresh(); });

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

  function refresh() {
    if (!engine) return;
    var parts = engine.replay(clues, cfg.layer);
    remKnown = parts.known;
    remTheo = parts.theoretical;
    remaining = engine.activeRemaining(cfg.layer, parts);
    if (!cfg.stepsTouched) {
      cfg.steps = Math.max(1, 6 - clues.length);
      if ($('cfgSteps')) $('cfgSteps').value = cfg.steps;
      if ($('treeBudget')) $('treeBudget').value = cfg.steps;
    }
    renderClues(); renderRemaining(); renderPreview();
    selectedKey = null; autoSel = true;
    $('bdRows').innerHTML = ''; $('bdSummary').textContent = ''; $('bdTitle').textContent = '';
    $('bdGuess').value = ''; delete $('bdRows').dataset.guess;
    scheduleScore();
    refreshOpeners();
    saveState();
  }

  // ---------- packs ----------
  function savedPacks() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } }
  function fillPackSel() {
    var sp = savedPacks(), sel = $('packSel');
    sel.innerHTML = BUILTIN.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('') +
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
    applyPage(cfg.page || 'both', true);
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
    $('packMsg').textContent = msg;
    var summary = ($('packSel').selectedOptions[0] || {}).textContent + ' · ' + engine.nKnown.toLocaleString() + ' answers';
    if (engine.pack.listSource) summary += ' · ' + engine.guessIdx.length.toLocaleString() + ' guesses';
    $('packSummary').textContent = summary;
    dropTree();
    cfg.L = engine.pack.length;
    if (!keepClues) clues = [];
    else clues = clues.map(function (c) {
      var g = engine.encode(c.key);
      return g.err || c.digits.length !== cfg.L ? null : Object.assign(c, { ids: g.ids, syms: g.syms, word: g.word });
    }).filter(Boolean);
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
  function renderNytCounts() {
    var el = $('nytCounts');
    if (!el) return;
    var src = engine && engine.pack && engine.pack.listSource;
    if (!src || packId !== 'nyt') { el.textContent = ''; return; }
    el.textContent = 'Loaded ' + src.answerCount.toLocaleString() + ' answers from ' + src.answers.file +
      ' and ' + src.guessCount.toLocaleString() + ' guesses from ' + src.guesses.file + '.';
  }
  function remoteStatus(eng) {
    var src = eng.pack.listSource;
    return 'Live from WordGamesBot · ' + src.answers.label + ': ' + eng.nKnown.toLocaleString() +
      ' answers · ' + src.guesses.label + ': ' + eng.guessIdx.length.toLocaleString() + ' valid guesses';
  }
  function packLabel(id) {
    var i;
    if (!id) return 'the built-in English pack';
    if (id.indexOf('saved:') === 0) return 'the saved pack ' + id.slice(6);
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
  function fetchRemoteList(spec, length, timeoutMs) {
    var cached = nytCache[spec.url];
    if (cached) return Promise.resolve(cached);
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
    engine = window.SolverEngine.create(pack, { answers: answersText || '', guesses: guessesText || '' });
    reportPack(keepClues);
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
        setPackWarn('Could not load the WordleBot lists (' + why + '). They are fetched live from the WordGamesBot repo and are not stored in this page. Staying on ' + packLabel(plan.packId) + '.');
        $('packMsg').textContent = 'WordleBot lists did not load. This pack is unchanged.';
      }
      packPhase = 'ready';
      scheduleScore();
      saveState();
      return Promise.resolve();
    }
    setPackWarn('Could not load the WordleBot lists (' + why + '). They are fetched live from the WordGamesBot repo and are not stored in this page. Showing ' + packLabel(plan.packId) + ' instead.');
    keepPackWarn = true;
    packId = plan.packId;
    fillPackSel();
    return loadPack(plan.packId, false);
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
      return Promise.all([
        fetchRemoteList(ans, pack.length, timeoutMs),
        fetchRemoteList(gue, pack.length, timeoutMs),
        Pack.loadRules(pack, function (rel) {
          return fetch('packs/' + rel).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.text();
          });
        })
      ]).then(function (parts) {
        if (!current()) return;
        pack.listSource = {
          repo: manifest.remote.repo,
          answers: ans,
          guesses: gue,
          answerCount: parts[0].count,
          guessCount: parts[1].count
        };
        nytLoaded = { answers: ans.id, guesses: gue.id };
        mountFetchedPack(pack, manifest, variant, builtin, parts[0].words.join('\n'), parts[1].words.join('\n'), parts[2], keepClues, applyDefaults);
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
    var b = BUILTIN.filter(function (x) { return x.id === id; })[0] || BUILTIN[0];
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
    if (packId.indexOf('saved:') !== 0) { alert('Select a saved (★) pack first.'); return; }
    var sp = savedPacks(); delete sp[packId.slice(6)]; localStorage.setItem(LS_KEY, JSON.stringify(sp));
    packId = 'en5'; fillPackSel(); loadPack('en5', false);
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
    if (!silent) {
      saveState();
      if (cfg.page !== 'tree') scheduleScore();
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
      return '<button type="button" class="ghost mini" data-pick="' + esc(w) + '">' + esc(showWord(w)) + '</button>';
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
      return '<tr data-word="' + esc(w) + '"><td>' + (i + 1) + '</td><td>' + esc(w) +
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
      listHtml += '<span class="' + cls + '" title="' + esc(title) + '">' + esc(engine.keys[d.idx]) + (d.proved ? ' ' + d.depth : ' ?') + '</span>';
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
    var head = '<div class="tree-head"><b>' + esc(showWord(treeWord(node.guess) || '—')) + mark + '</b>';
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
      else if (ch.node && ch.node.guess != null) rows += '<span class="next">' + esc(treeWord(ch.node.guess)) + ((!ch.node.forced && ch.node.policyExact === false) ? ' ≈' : '') + '</span>';
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

  function saveState() {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify({
        packId: packId, cfg: cfg,
        clues: clues.map(function (c) { return { key: c.key, digits: c.digits }; })
      }));
    } catch (e) {}
  }
  function init() {
    var st = null; try { st = JSON.parse(localStorage.getItem(LS_STATE) || 'null'); } catch (e) {}
    if (st && st.cfg) {
        ['mode', 'hard', 'ansOnly', 'max', 'top', 'notation', 'valid', 'layer', 'guessMode', 'page', 'guarantee', 'steps', 'stepsTouched', 'treePolicy', 'nytAnswers', 'nytGuesses'].forEach(function (k) {
        if (st.cfg[k] !== undefined) cfg[k] = st.cfg[k];
      });
      if (!st.cfg.guessMode) cfg.guessMode = inferGuessMode();
    }
    nytWant.answers = cfg.nytAnswers || 'with-ed';
    nytWant.guesses = cfg.nytGuesses || 'all';
    if ($('nytAnswers')) $('nytAnswers').value = nytWant.answers;
    if ($('nytGuesses')) $('nytGuesses').value = nytWant.guesses;
    var pid = st && st.packId && (st.packId.indexOf('saved:') === 0 ? savedPacks()[st.packId.slice(6)] : BUILTIN.some(function (b) { return b.id === st.packId && !b.blank; })) ? st.packId : 'en5';
    packId = pid; fillPackSel(); writeCfgToUI();
    loadPack(pid, false).then(function () {
      if (st && st.clues && st.clues.length && engine) {
        st.clues.forEach(function (c) {
          var g = engine.encode(c.key);
          if (!g.err && c.digits && c.digits.length === cfg.L) {
            var made = engine.makeClue(g.key, c.digits);
            clues.push({ key: made.key, ids: made.ids, syms: made.syms, digits: made.digits, pat: made.pat, word: made.word, clue: made.clue, note: validityNote(made.key) });
          }
        });
        refresh();
      }
    });
  }
  init();
})();
