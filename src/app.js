/* Wordle-style Solver — UI. Pools, clues, and scoring go through SolverEngine. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var Core = window.SolverCore;
  var Pack = window.SolverPack;
  var Renderers = window.SolverRenderers;
  var LS_KEY = 'geek-solver-packs-v1', LS_STATE = 'geek-solver-state-v1';

  var BUILTIN = [
    { id: 'en5', name: 'Wordle — English 5-letter (built-in)', variant: 'wordle-en-5' },
    { id: 'en4', name: 'English 4-letter (built-in)', variant: 'wordle-en-4' },
    { id: 'en6', name: 'English 6-letter (built-in)', variant: 'wordle-en-6' },
    { id: 'en7', name: 'English 7-letter (built-in)', variant: 'wordle-en-7' },
    { id: 'en8', name: 'English 8-letter (built-in)', variant: 'wordle-en-8' },
    { id: 'blank', name: 'Custom — paste / upload your own lists', blank: true },
    { id: 'digits', name: 'Custom digits (0-9) — paste your list', blank: true, preset: { L: 5, alpha: '0123456789' } },
    { id: 'tokens', name: 'Custom tokens (cards, emoji…) — paste your list', blank: true, preset: { tok: true, alpha: '', ci: false } }
  ];

  var cfg = { L: 5, alpha: 'abcdefghijklmnopqrstuvwxyz', ci: true, tok: false, rule: 'wordle', valid: 'both',
    mode: 'avg', hard: 'off', ansOnly: false, max: 12000, top: 15, notation: 'GYB',
    layer: 'known', guessMode: 'dictionary', page: 'both' };
  var packId = 'en5';
  var engine = null;
  var manifestP = null;
  var clues = [];
  var remaining = [];
  var remKnown = [];
  var remTheo = [];
  var lastTop = [], selectedKey = null, autoSel = true, bdFilterPat = null;
  var worker = null, reqId = 0, scoreTimer = null;

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
  function digitsToPat(d) { return Pack.digitsToPat(d); }
  function patToDigits(p) { return Pack.patToDigits(p, cfg.L); }
  function patCode(d) {
    var id = engine ? engine.pack.clueRenderer : 'clues/wordle-gyb';
    return Renderers.clueCode(id, d, cfg.notation, engine && engine.pack);
  }
  function tilesHTML(syms, digits, opts) {
    var id = engine ? engine.pack.tokenRenderer : 'tiles/letters';
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
    var i = +t.dataset.i; previewDigits[i] = ((previewDigits[i] || 0) + 1) % 3;
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
  function renderSuggestions(top) {
    lastTop = top;
    var tb = $('sugTable').tBodies[0];
    tb.innerHTML = top.map(function (s, i) {
      var k = engine.keys[s.idx];
      return '<tr data-key="' + esc(k) + '"' + (k === selectedKey ? ' class="sel"' : '') + '><td>' + (i + 1) + '</td><td>' + esc(k) + '</td><td>' + stepsText(s) + '</td><td>' + fmt(s.exp, 2) +
        '</td><td>' + s.worst + '</td><td>' + s.splits + '</td><td>' + fmt(s.ent, 2) + '</td><td>' + (s.cand ? '<span class="ok">✓</span>' : '') + '</td></tr>';
    }).join('');
    var col = { steps: 2, avg: 3, minimax: 4, splits: 5, entropy: 6 }[cfg.mode];
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
    $('bdSummary').innerHTML = n ? ('If you guess <b>' + esc(g.key.toUpperCase()) + '</b> with ' + n + ' answers possible: ' + rows.length + ' possible results · expected ' + fmt(n ? sumSq / n : 0, 2) +
      ' left · worst case ' + worst + ' · ' + fmt(ent, 2) + ' bits' + stepsBit + (buckets.has(allGreen) ? ' · <span class="ok">could be the answer</span>' : '') +
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
  function scheduleScore() { clearTimeout(scoreTimer); scoreTimer = setTimeout(runScore, 120); }
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
    var msg = { id: id, U: engine.U, L: cfg.L, K: engine.syms.length, rule: engine.feedbackRule, rem: Int32Array.from(remaining), pool: Int32Array.from(bp.pool), isCand: isCand, mode: cfg.mode, topN: cfg.top };
    if (cfg.mode === 'steps') msg.steps = stepsPayload();
    var label = 'Scoring ' + bp.pool.length.toLocaleString() + ' guesses × ' + remaining.length.toLocaleString() + ' ' + layerLabel() +
      (bp.pruned ? ' (pre-filtered from ' + bp.total.toLocaleString() + ' by letter coverage — raise “Max guesses to score” for a full search)' : '') +
      (cfg.mode === 'steps' ? ' · expected steps' : '');
    $('scoreStatus').innerHTML = esc(label) + '…<div class="bar"><i id="pbar"></i></div>';
    var done = function (top, ms) {
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
      $('scoreStatus').textContent = label.replace('Scoring', 'Scored') + ' in ' + ms + ' ms.' + tail;
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
            var pct = d.phase === 'steps' ? 70 + 30 * frac : (cfg.mode === 'steps' ? 70 : 100) * frac;
            b.style.width = pct + '%';
          }
        }
        else { done(d.top, d.ms); worker.terminate(); worker = null; }
      };
      worker.onerror = function () { worker = null; syncScore(); };
      worker.postMessage(msg);
    } catch (err) { syncScore(); }
    function syncScore() {
      setTimeout(function () {
        var t0 = Date.now();
        var sc = Core.scorePool(msg.U, msg.L, msg.K, msg.rule, msg.rem, msg.pool, msg.isCand);
        if (msg.mode === 'steps') {
          var st = msg.steps || {};
          Core.attachExpectedSteps(sc, msg.U, msg.L, msg.K, msg.rule, msg.rem, msg.pool, {
            guessMode: st.guessMode, hard: st.hard, dict: st.dict, clues: st.clues || []
          });
        }
        done(Core.rank(sc, msg.mode, msg.topN), Date.now() - t0);
      }, 10);
    }
  }

  function refresh() {
    if (!engine) return;
    var parts = engine.replay(clues, cfg.layer);
    remKnown = parts.known;
    remTheo = parts.theoretical;
    remaining = engine.activeRemaining(cfg.layer, parts);
    renderClues(); renderRemaining(); renderPreview();
    selectedKey = null; autoSel = true;
    $('bdRows').innerHTML = ''; $('bdSummary').textContent = ''; $('bdTitle').textContent = '';
    $('bdGuess').value = ''; delete $('bdRows').dataset.guess;
    scheduleScore();
    saveState();
  }

  // ---------- packs ----------
  function savedPacks() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } }
  function fillPackSel() {
    var sp = savedPacks(), sel = $('packSel');
    sel.innerHTML = BUILTIN.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('') +
      Object.keys(sp).map(function (k) { return '<option value="saved:' + esc(k) + '">★ ' + esc(k) + '</option>'; }).join('');
    sel.value = packId;
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
    $('cfgLayer').value = cfg.layer || 'known';
    $('cfgGuessMode').value = cfg.guessMode || inferGuessMode();
    applyPage(cfg.page || 'both', true);
  }
  function reportPack(keepClues) {
    var msg = engine.nKnown.toLocaleString() + ' answers, ' + (engine.nWords - engine.nKnown).toLocaleString() + ' extra guesses';
    if (engine.rej) msg += ' · ' + engine.rej + ' entries skipped (wrong length/alphabet)';
    if (engine.dup) msg += ' · ' + engine.dup + ' duplicates merged';
    $('packMsg').textContent = msg;
    $('packSummary').textContent = ($('packSel').selectedOptions[0] || {}).textContent + ' · ' + engine.nKnown.toLocaleString() + ' answers';
    cfg.L = engine.pack.length;
    if (!keepClues) clues = [];
    else clues = clues.map(function (c) {
      var g = engine.encode(c.key);
      return g.err || c.digits.length !== cfg.L ? null : Object.assign(c, { ids: g.ids, syms: g.syms, word: g.word });
    }).filter(Boolean);
    $('bdGuess').value = ''; selectedKey = null;
    refresh();
  }
  function mountCustom(keepClues) {
    readCfgFromUI();
    var pack = Pack.fromCustom({
      length: cfg.L, alphabet: cfg.alpha, caseInsensitive: cfg.ci, tokens: cfg.tok, rule: cfg.rule, name: 'Custom'
    });
    engine = window.SolverEngine.create(pack, { answers: $('ansText').value, guesses: $('guessText').value });
    engine.feedbackRule = cfg.rule === 'simple' ? 'simple' : 'wordle';
    reportPack(keepClues);
  }
  function englishManifest() {
    if (!manifestP) {
      manifestP = fetch('packs/wordle-en.json').then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).catch(function (e) { manifestP = null; throw e; });
    }
    return manifestP;
  }
  function loadPack(id, keepClues) {
    packId = id;
    if (id.indexOf('saved:') === 0) {
      var p = savedPacks()[id.slice(6)]; if (!p) return Promise.resolve();
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
    $('packMsg').textContent = 'Loading…';
    return englishManifest().then(function (manifest) {
      var variant = null;
      (manifest.variants || []).forEach(function (v) { if (v.id === b.variant) variant = v; });
      if (!variant) throw new Error('missing variant ' + b.variant);
      var pack = Pack.normalize(manifest, variant);
      function fetchPack(rel) {
        return fetch('packs/' + rel).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
      }
      return Promise.all([
        fetchPack(variant.knownSolutions),
        fetchPack(variant.guessList),
        Pack.loadRules(pack, fetchPack)
      ]).then(function (t) {
        cfg.L = pack.length; cfg.tok = false; cfg.ci = pack.caseInsensitive;
        cfg.alpha = typeof manifest.alphabet === 'string' ? manifest.alphabet : cfg.alpha;
        cfg.rule = pack.feedback === 'simple' ? 'simple' : 'wordle';
        writeCfgToUI();
        $('ansText').value = t[0].trim(); $('guessText').value = t[1].trim();
        pack.rulesImpl = t[2];
        engine = window.SolverEngine.create(pack, { answers: t[0], guesses: t[1] });
        reportPack(keepClues);
      });
    }).catch(function (e) {
      $('packMsg').textContent = 'Could not load built-in pack (' + e.message + '). Paste or upload lists instead.';
      $('setupCard').open = true;
    });
  }
  $('packSel').addEventListener('change', function () { loadPack($('packSel').value, false); });
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
  $('cfgHard').addEventListener('change', function () {
    cfg.hard = this.value; syncGuessModeLabel(); renderClues(); scheduleScore(); saveState();
  });
  $('cfgAnsOnly').addEventListener('change', function () { cfg.ansOnly = this.checked; syncGuessModeLabel(); scheduleScore(); saveState(); });
  $('cfgMax').addEventListener('change', function () { cfg.max = Math.max(10, parseInt(this.value, 10) || 12000); scheduleScore(); saveState(); });
  $('cfgTop').addEventListener('change', function () { cfg.top = Math.max(1, Math.min(500, parseInt(this.value, 10) || 15)); scheduleScore(); saveState(); });
  $('cfgValid').addEventListener('change', function () {
    cfg.valid = this.value; syncGuessModeLabel();
    clues.forEach(function (c) { c.note = validityNote(c.key); });
    renderClues(); scheduleScore(); saveState();
  });
  $('cfgRule').addEventListener('change', function () {
    cfg.rule = this.value;
    if (engine) engine.feedbackRule = this.value === 'simple' ? 'simple' : 'wordle';
    refresh();
  });
  $('cfgLayer').addEventListener('change', function () { cfg.layer = this.value; refresh(); });
  $('cfgGuessMode').addEventListener('change', function () {
    var mode = this.value;
    cfg.guessMode = mode;
    if (mode === 'any') { cfg.valid = 'any'; cfg.hard = 'off'; cfg.ansOnly = false; }
    else if (mode === 'hard') { cfg.valid = 'both'; cfg.hard = 'strict'; cfg.ansOnly = false; }
    else if (mode === 'answersOnly') { cfg.valid = 'both'; cfg.hard = 'off'; cfg.ansOnly = true; }
    else { cfg.valid = 'both'; cfg.hard = 'off'; cfg.ansOnly = false; cfg.guessMode = 'dictionary'; }
    $('cfgValid').value = cfg.valid; $('cfgHard').value = cfg.hard; $('cfgAnsOnly').checked = cfg.ansOnly;
    clues.forEach(function (c) { c.note = validityNote(c.key); });
    renderClues(); scheduleScore(); saveState();
  });

  function applyPage(page, silent) {
    cfg.page = page || 'both';
    document.body.setAttribute('data-page', cfg.page);
    Array.prototype.forEach.call(document.querySelectorAll('#pageModes button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-page') === cfg.page);
    });
    if (!silent) saveState();
  }
  $('pageModes').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-page]'); if (!b) return;
    applyPage(b.getAttribute('data-page'));
  });

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
      ['mode', 'hard', 'ansOnly', 'max', 'top', 'notation', 'valid', 'layer', 'guessMode', 'page'].forEach(function (k) {
        if (st.cfg[k] !== undefined) cfg[k] = st.cfg[k];
      });
      if (!st.cfg.guessMode) cfg.guessMode = inferGuessMode();
    }
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
