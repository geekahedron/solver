/* Wordle-style Solver — UI + game state. No backend; packs load from ./packs/ or from paste/upload. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var Core = window.SolverCore;
  var LS_KEY = 'geek-solver-packs-v1', LS_STATE = 'geek-solver-state-v1';

  var BUILTIN = [
    { id: 'en5', name: 'Wordle — English 5-letter (built-in)', L: 5, ans: 'packs/english5-answers.txt', gss: 'packs/english5-guesses.txt' },
    { id: 'en4', name: 'English 4-letter (built-in)', L: 4, ans: 'packs/english4-answers.txt', gss: 'packs/english4-guesses.txt' },
    { id: 'en6', name: 'English 6-letter (built-in)', L: 6, ans: 'packs/english6-answers.txt', gss: 'packs/english6-guesses.txt' },
    { id: 'en7', name: 'English 7-letter (built-in)', L: 7, ans: 'packs/english7-answers.txt', gss: 'packs/english7-guesses.txt' },
    { id: 'en8', name: 'English 8-letter (built-in)', L: 8, ans: 'packs/english8-answers.txt', gss: 'packs/english8-guesses.txt' },
    { id: 'blank', name: 'Custom — paste / upload your own lists', blank: true },
    { id: 'digits', name: 'Custom digits (0-9) — paste your list', blank: true, preset: { L: 5, alpha: '0123456789' } },
    { id: 'tokens', name: 'Custom tokens (cards, emoji…) — paste your list', blank: true, preset: { tok: true, alpha: '', ci: false } }
  ];

  var cfg = { L: 5, alpha: 'abcdefghijklmnopqrstuvwxyz', ci: true, tok: false, rule: 'wordle', valid: 'both',
    mode: 'avg', hard: 'off', ansOnly: false, max: 12000, top: 15, notation: 'GYB' };
  var packId = 'en5';
  // Encoded game
  var G = null; // {symId:Map, syms:[], words:[keys], U:Uint16Array (grown), nAns, keyIdx:Map, nWords}
  var clues = []; // {key, syms:[ids], pat:int, digits:[]}
  var remaining = []; // universe idx
  var lastTop = [], selectedKey = null, autoSel = true, bdFilterPat = null;
  var worker = null, reqId = 0, scoreTimer = null;

  // ---------- parsing ----------
  function norm(s) { s = String(s).normalize ? String(s).normalize('NFC') : String(s); return cfg.ci ? s.toLowerCase() : s; }
  function splitSyms(s) {
    s = norm(s).trim();
    if (!s) return [];
    if (cfg.tok) return s.split(/[\s,]+/).filter(Boolean);
    return Array.from(s.replace(/\s+/g, ''));
  }
  function alphaSet() {
    var a = norm(cfg.alpha || '').trim();
    if (!a) return null;
    var arr = cfg.tok ? a.split(/[\s,]+/).filter(Boolean) : Array.from(a.replace(/\s+/g, ''));
    return new Set(arr);
  }
  function splitList(text) {
    if (!text) return [];
    // Token mode: one entry per line. Letter mode: any whitespace/comma separates.
    return cfg.tok ? text.split(/\r?\n/) : text.split(/[\s,;]+/);
  }
  function symKey(syms) { return cfg.tok ? syms.join(' ') : syms.join(''); }

  function buildGame(ansText, guessText) {
    var as = alphaSet(), L = cfg.L;
    var g = { symId: new Map(), syms: [], words: [], keyIdx: new Map(), nAns: 0, rej: 0, dup: 0, cap: 0, U: null };
    var tmp = [];
    function add(raw, isAns) {
      var syms = splitSyms(raw);
      if (!syms.length) return;
      if (syms.length !== L) { g.rej++; return; }
      if (as) for (var i = 0; i < L; i++) if (!as.has(syms[i])) { g.rej++; return; }
      var k = symKey(syms);
      if (g.keyIdx.has(k)) { g.dup++; return; }
      g.keyIdx.set(k, g.words.length); g.words.push(k); tmp.push(syms.map(symIdOf));
    }
    function symIdOf(s) { var id = g.symId.get(s); if (id === undefined) { id = g.syms.length; g.symId.set(s, id); g.syms.push(s); } return id; }
    g.symIdOf = symIdOf;
    splitList(ansText).forEach(function (w) { add(w, true); });
    g.nAns = g.words.length;
    splitList(guessText).forEach(function (w) { add(w, false); });
    g.nWords = g.words.length;
    g.U = new Uint16Array(Math.max(1, g.nWords) * L);
    tmp.forEach(function (s, i) { for (var j = 0; j < L; j++) g.U[i * L + j] = s[j]; });
    g.tokArr = tmp;
    return g;
  }
  // Encode an arbitrary guess (may add new symbols, never added to the word lists)
  function encodeGuess(raw) {
    var syms = splitSyms(raw);
    if (syms.length !== cfg.L) return { err: 'needs ' + cfg.L + (cfg.tok ? ' tokens' : ' letters') + ' (got ' + syms.length + ')' };
    var as = alphaSet();
    if (as) for (var i = 0; i < syms.length; i++) if (!as.has(syms[i])) return { err: '"' + syms[i] + '" is not in the alphabet' };
    return { key: symKey(syms), ids: syms.map(G.symIdOf), syms: syms };
  }
  function validityNote(key) {
    var idx = G.keyIdx.get(key);
    if (cfg.valid === 'any') return '';
    if (idx === undefined) return 'not in ' + (cfg.valid === 'answers' ? 'answer list' : 'word lists');
    if (cfg.valid === 'answers' && idx >= G.nAns) return 'not in answer list';
    return '';
  }

  // Pattern parsing: returns digits array (0 gray,1 yellow,2 green) or null
  var PAT_MAP = { g: 2, '2': 2, c: 2, '🟩': 2, '🟢': 2, y: 1, '1': 1, p: 1, o: 1, '🟨': 1, '🟧': 1, '🟡': 1,
    b: 0, r: 0, x: 0, w: 0, a: 0, '0': 0, '-': 0, '.': 0, '_': 0, '⬛': 0, '⬜': 0, '🟥': 0, '⚫': 0, '⚪': 0 };
  function parsePat(s) {
    var arr = Array.from(String(s).toLowerCase().replace(/[\s\uFE0F\u200D]/g, ''));
    var out = [];
    for (var i = 0; i < arr.length; i++) { var v = PAT_MAP[arr[i]]; if (v === undefined) return null; out.push(v); }
    return out.length === cfg.L ? out : null;
  }
  function digitsToPat(d) { var p = 0, m = 1; for (var i = 0; i < d.length; i++, m *= 3) p += d[i] * m; return p; }
  function patToDigits(p) { var d = []; for (var i = 0; i < cfg.L; i++) { d.push(p % 3); p = Math.floor(p / 3); } return d; }
  var NOT = { GYB: ['B', 'Y', 'G'], gyr: ['r', 'y', 'g'], '210': ['0', '1', '2'], emoji: ['⬛', '🟨', '🟩'] };
  function patCode(d) { var n = NOT[cfg.notation] || NOT.GYB; return d.map(function (x) { return n[x]; }).join(''); }

  // ---------- feedback helpers on main thread ----------
  var counts = new Int16Array(64);
  function ensureCounts() { if (counts.length < G.syms.length + 2) counts = new Int16Array(G.syms.length + 64); }
  function fbIdsVsIdx(ids, idx, pow3) { ensureCounts(); return Core.feedback(ids, 0, G.U, idx * cfg.L, cfg.L, cfg.rule, counts, pow3); }

  // ---------- state recompute ----------
  function computeRemaining() {
    var pow3 = Core.pow3(cfg.L), rem = [];
    outer: for (var i = 0; i < G.nAns; i++) {
      for (var c = 0; c < clues.length; c++) if (fbIdsVsIdx(clues[c].ids, i, pow3) !== clues[c].pat) continue outer;
      rem.push(i);
    }
    remaining = rem;
  }
  function hardOk(idx) { // Wordle hard mode: greens stay, revealed letters (with counts) reused
    var L = cfg.L, base = idx * L;
    for (var c = 0; c < clues.length; c++) {
      var cl = clues[c], need = new Map();
      for (var i = 0; i < L; i++) {
        if (cl.digits[i] === 2 && G.U[base + i] !== cl.ids[i]) return false;
        if (cl.digits[i] > 0) need.set(cl.ids[i], (need.get(cl.ids[i]) || 0) + 1);
      }
      var ok = true;
      need.forEach(function (n, s) { var have = 0; for (var j = 0; j < L; j++) if (G.U[base + j] === s) have++; if (have < n) ok = false; });
      if (!ok) return false;
    }
    return true;
  }
  function strictOk(idx, pow3) {
    for (var c = 0; c < clues.length; c++) {
      var p = Core.feedback(clues[c].ids, 0, G.U, idx * cfg.L, cfg.L, cfg.rule, counts, pow3);
      if (p !== clues[c].pat) return false;
    }
    return true;
  }
  function buildPool() {
    var pool, pow3 = Core.pow3(cfg.L);
    ensureCounts();
    if (cfg.ansOnly) pool = remaining.slice();
    else { var n = cfg.valid === 'answers' ? G.nAns : G.nWords; pool = []; for (var i = 0; i < n; i++) pool.push(i); }
    if (cfg.hard === 'wordle') pool = pool.filter(hardOk);
    else if (cfg.hard === 'strict') pool = pool.filter(function (i) { return strictOk(i, pow3); });
    var pruned = false, total = pool.length;
    if (pool.length > cfg.max) { pool = prunePool(pool); pruned = true; }
    return { pool: pool, pruned: pruned, total: total };
  }
  // Heuristic pre-filter when the pool is larger than "max guesses to score":
  // keep possible answers (up to half the budget) plus the guesses with the best letter-coverage of the remaining answers.
  function prunePool(pool) {
    var L = cfg.L, K = G.syms.length, n = remaining.length;
    var pres = new Float64Array(K), pos = new Float64Array(K * L), seen = new Int32Array(K).fill(-1);
    remaining.forEach(function (r, ri) { for (var i = 0; i < L; i++) { var s = G.U[r * L + i]; pos[s * L + i]++; if (seen[s] !== ri) { seen[s] = ri; pres[s]++; } } });
    var remSet = new Set(remaining);
    var cands = [], others = [];
    pool.forEach(function (gi) {
      var h = 0, used = new Set();
      for (var i = 0; i < L; i++) {
        var s = G.U[gi * L + i];
        var pf = pos[s * L + i]; h += 0.5 * Math.min(pf, n - pf);
        if (!used.has(s)) { used.add(s); h += Math.min(pres[s], n - pres[s]); }
      }
      (remSet.has(gi) ? cands : others).push({ gi: gi, h: h });
    });
    var byH = function (a, b) { return b.h - a.h; };
    cands.sort(byH); others.sort(byH);
    var keepC = cands.slice(0, Math.floor(cfg.max / 2));
    var keepO = others.slice(0, cfg.max - keepC.length);
    if (keepO.length < cfg.max - keepC.length) keepC = cands.slice(0, cfg.max - keepO.length);
    return keepC.concat(keepO).map(function (x) { return x.gi; });
  }

  // ---------- rendering ----------
  function tilesHTML(syms, digits) {
    var cls = ['b', 'y', 'g'];
    return '<span class="tiles">' + syms.map(function (s, i) {
      return '<span class="tile ' + (digits ? cls[digits[i]] : 'e') + '">' + esc(s) + '</span>';
    }).join('') + '</span>';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function symsOfIdx(i) { var L = cfg.L, o = []; for (var j = 0; j < L; j++) o.push(G.syms[G.U[i * L + j]]); return o; }

  var previewDigits = null;
  function renderPreview() {
    var syms = splitSyms($('clueGuess').value).slice(0, cfg.L);
    while (syms.length < cfg.L) syms.push('');
    var pd = parsePat($('cluePat').value);
    if (pd) previewDigits = pd;
    if (!previewDigits || previewDigits.length !== cfg.L) previewDigits = new Array(cfg.L).fill(0);
    var cls = ['b', 'y', 'g'];
    $('cluePreview').innerHTML = syms.map(function (s, i) { return '<span class="tile ' + cls[previewDigits[i]] + '" data-i="' + i + '">' + esc(s || '·') + '</span>'; }).join('');
  }
  $('cluePreview').addEventListener('click', function (e) {
    var t = e.target.closest('.tile'); if (!t) return;
    var i = +t.dataset.i; previewDigits[i] = ((previewDigits[i] || 0) + 1) % 3; // gray→yellow→green→gray
    $('cluePat').value = patCode(previewDigits).replace(/⬛/g, 'b').replace(/🟨/g, 'y').replace(/🟩/g, 'g');
    renderPreview();
  });

  function renderClues() {
    $('clueList').innerHTML = clues.map(function (c, i) {
      return '<div class="clue-row">' + tilesHTML(c.syms, c.digits) + '<span class="meta">' + esc(patCode(c.digits)) +
        (c.note ? ' · <span class="warn">' + esc(c.note) + '</span>' : '') + ' · ' + c.after + ' left after</span>' +
        '<button class="ghost mini" data-del="' + i + '">✕</button></div>';
    }).join('') || '<p class="muted small">No clues yet — showing best opening guesses.</p>';
  }
  $('clueList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-del]'); if (!b) return;
    clues.splice(+b.dataset.del, 1); refresh();
  });

  function renderRemaining() {
    $('remCount').textContent = remaining.length.toLocaleString() + (G.nAns ? ' / ' + G.nAns.toLocaleString() : '');
    if ($('remDetails').open) {
      var shown = remaining.slice(0, 3000).map(function (i) { return esc(G.words[i]); });
      $('remList').innerHTML = shown.map(function (w) { return '<div>' + w + '</div>'; }).join('') +
        (remaining.length > 3000 ? '<div class="muted">… +' + (remaining.length - 3000) + ' more</div>' : '');
    }
  }
  $('remDetails').addEventListener('toggle', renderRemaining);

  function fmt(x, d) { return (Math.round(x * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d); }
  function renderSuggestions(top) {
    lastTop = top;
    var tb = $('sugTable').tBodies[0];
    tb.innerHTML = top.map(function (s, i) {
      var k = G.words[s.idx];
      return '<tr data-key="' + esc(k) + '"' + (k === selectedKey ? ' class="sel"' : '') + '><td>' + (i + 1) + '</td><td>' + esc(k) + '</td><td>' + fmt(s.exp, 2) +
        '</td><td>' + s.worst + '</td><td>' + s.splits + '</td><td>' + fmt(s.ent, 2) + '</td><td>' + (s.cand ? '<span class="ok">✓</span>' : '') + '</td></tr>';
    }).join('');
    var col = { avg: 2, minimax: 3, splits: 4, entropy: 5 }[cfg.mode];
    Array.prototype.forEach.call($('sugTable').tHead.rows[0].cells, function (th, i) { th.classList.toggle('sortcol', i === col); });
  }
  $('sugTable').tBodies[0].addEventListener('click', function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    autoSel = false; $('bdGuess').value = tr.dataset.key; analyze(tr.dataset.key, true);
  });

  // ---------- breakdown ----------
  function analyze(raw, scroll) {
    if (!G) return;
    var g = encodeGuess(raw);
    if (g.err) { $('bdSummary').innerHTML = '<span class="warn">' + esc(g.err) + '</span>'; $('bdRows').innerHTML = ''; return; }
    selectedKey = g.key;
    Array.prototype.forEach.call($('sugTable').tBodies[0].rows, function (tr) { tr.classList.toggle('sel', tr.dataset.key === g.key); });
    var pow3 = Core.pow3(cfg.L), buckets = new Map();
    remaining.forEach(function (r) { var p = fbIdsVsIdx(g.ids, r, pow3); var a = buckets.get(p); if (!a) buckets.set(p, a = []); a.push(r); });
    var n = remaining.length, allGreen = digitsToPat(new Array(cfg.L).fill(2));
    var rows = Array.from(buckets.entries()).sort(function (a, b) { return b[1].length - a[1].length || a[0] - b[0]; });
    var sumSq = 0, worst = 0, ent = 0;
    rows.forEach(function (r) { var c = r[1].length, p = c / n; ent -= p * Math.log2(p); if (r[0] !== allGreen) { sumSq += c * c; worst = Math.max(worst, c); } });
    var note = validityNote(g.key);
    $('bdTitle').innerHTML = '· ' + tilesHTML(g.syms, null);
    $('bdSummary').innerHTML = n ? ('If you guess <b>' + esc(g.key.toUpperCase()) + '</b> with ' + n + ' answers possible: ' + rows.length + ' possible results · expected ' + fmt(n ? sumSq / n : 0, 2) +
      ' left · worst case ' + worst + ' · ' + fmt(ent, 2) + ' bits' + (buckets.has(allGreen) ? ' · <span class="ok">could be the answer</span>' : '') +
      (cfg.hard !== 'off' && G.keyIdx.has(g.key) && !(cfg.hard === 'wordle' ? hardOk(G.keyIdx.get(g.key)) : strictOk(G.keyIdx.get(g.key), pow3)) ? ' · <span class="warn">breaks hard mode</span>' : '') +
      (note ? ' · <span class="warn">' + esc(note) + '</span>' : '')) : 'No answers remain — check your clues.';
    var html = rows.map(function (r) {
      var d = patToDigits(r[0]), words = r[1].map(function (i) { return G.words[i]; });
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

  // ---------- clues ----------
  function addClue(raw, digits) {
    var g = encodeGuess(raw);
    if (g.err) { alert('Guess ' + g.err); return false; }
    if (!digits) { alert('Result must be ' + cfg.L + ' codes, e.g. ' + 'bgybb'.slice(0, cfg.L)); return false; }
    clues.push({ key: g.key, ids: g.ids, syms: g.syms, digits: digits, pat: digitsToPat(digits), note: validityNote(g.key) });
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
  function scheduleScore() { clearTimeout(scoreTimer); scoreTimer = setTimeout(runScore, 120); }
  function runScore() {
    if (!G || !G.nAns) { renderSuggestions([]); $('scoreStatus').textContent = 'Load an answer list to get suggestions.'; return; }
    if (!remaining.length) { renderSuggestions([]); $('scoreStatus').innerHTML = '<span class="warn">No answers fit these clues.</span>'; return; }
    var bp = buildPool();
    if (!bp.pool.length) { renderSuggestions([]); $('scoreStatus').textContent = 'No allowed guesses under these settings.'; return; }
    var isCand = new Uint8Array(G.nWords); remaining.forEach(function (i) { isCand[i] = 1; });
    var id = ++reqId;
    var msg = { id: id, U: G.U, L: cfg.L, K: G.syms.length, rule: cfg.rule, rem: Int32Array.from(remaining), pool: Int32Array.from(bp.pool), isCand: isCand, mode: cfg.mode, topN: cfg.top };
    var label = 'Scoring ' + bp.pool.length.toLocaleString() + ' guesses × ' + remaining.length.toLocaleString() + ' answers' +
      (bp.pruned ? ' (pre-filtered from ' + bp.total.toLocaleString() + ' by letter coverage — raise “Max guesses to score” for a full search)' : '');
    $('scoreStatus').innerHTML = esc(label) + '…<div class="bar"><i id="pbar"></i></div>';
    var done = function (top, ms) {
      if (id !== reqId) return;
      renderSuggestions(top);
      $('scoreStatus').textContent = label.replace('Scoring', 'Scored') + ' in ' + ms + ' ms.';
      if ((autoSel || !selectedKey) && top.length) { $('bdGuess').value = G.words[top[0].idx]; analyze(G.words[top[0].idx], false); }
      else if (selectedKey) analyze(selectedKey, false);
    };
    if (worker) { worker.terminate(); worker = null; }
    try {
      if (location.protocol === 'file:') throw new Error('no worker on file://');
      worker = new Worker('worker.js');
      worker.onmessage = function (e) {
        var d = e.data; if (d.id !== reqId) return;
        if (d.type === 'progress') { var b = $('pbar'); if (b) b.style.width = (100 * d.done / d.total) + '%'; }
        else { done(d.top, d.ms); worker.terminate(); worker = null; }
      };
      worker.onerror = function () { worker = null; syncScore(); };
      worker.postMessage(msg);
    } catch (err) { syncScore(); }
    function syncScore() {
      setTimeout(function () {
        var t0 = Date.now();
        var sc = Core.scorePool(msg.U, msg.L, msg.K, msg.rule, msg.rem, msg.pool, msg.isCand);
        done(Core.rank(sc, msg.mode, msg.topN), Date.now() - t0);
      }, 10);
    }
  }

  // ---------- refresh ----------
  function refresh() {
    if (!G) return;
    // recompute remaining incrementally to show per-clue counts
    var saved = clues; var pow3 = Core.pow3(cfg.L); ensureCounts();
    var rem = []; for (var i = 0; i < G.nAns; i++) rem.push(i);
    saved.forEach(function (c) { rem = rem.filter(function (r) { return fbIdsVsIdx(c.ids, r, pow3) === c.pat; }); c.after = rem.length; });
    remaining = rem;
    renderClues(); renderRemaining(); renderPreview();
    selectedKey = null; autoSel = true; // let the top suggestion become the breakdown again
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
  }
  function applySetup(keepClues) {
    readCfgFromUI();
    G = buildGame($('ansText').value, $('guessText').value);
    var msg = G.nAns.toLocaleString() + ' answers, ' + (G.nWords - G.nAns).toLocaleString() + ' extra guesses';
    if (G.rej) msg += ' · ' + G.rej + ' entries skipped (wrong length/alphabet)';
    if (G.dup) msg += ' · ' + G.dup + ' duplicates merged';
    $('packMsg').textContent = msg;
    $('packSummary').textContent = ($('packSel').selectedOptions[0] || {}).textContent + ' · ' + G.nAns.toLocaleString() + ' answers';
    if (!keepClues) clues = [];
    else clues = clues.map(function (c) { var g = encodeGuess(c.key); return g.err || c.digits.length !== cfg.L ? null : Object.assign(c, { ids: g.ids, syms: g.syms }); }).filter(Boolean);
    $('bdGuess').value = ''; selectedKey = null;
    refresh();
  }
  function loadPack(id, keepClues) {
    packId = id;
    if (id.indexOf('saved:') === 0) {
      var p = savedPacks()[id.slice(6)]; if (!p) return;
      Object.assign(cfg, p.cfg || {}); writeCfgToUI();
      $('ansText').value = p.answers || ''; $('guessText').value = p.guesses || '';
      applySetup(keepClues); return Promise.resolve();
    }
    var b = BUILTIN.filter(function (x) { return x.id === id; })[0] || BUILTIN[0];
    if (b.blank) {
      cfg.tok = false; cfg.ci = true; cfg.alpha = 'abcdefghijklmnopqrstuvwxyz';
      if (b.preset) Object.assign(cfg, b.preset);
      writeCfgToUI(); $('ansText').value = ''; $('guessText').value = '';
      $('setupCard').open = true; applySetup(false); return Promise.resolve();
    }
    $('packMsg').textContent = 'Loading…';
    return Promise.all([fetch(b.ans).then(function (r) { return r.text(); }), fetch(b.gss).then(function (r) { return r.text(); })]).then(function (t) {
      cfg.L = b.L; cfg.tok = false; cfg.ci = true; cfg.alpha = 'abcdefghijklmnopqrstuvwxyz'; writeCfgToUI();
      $('ansText').value = t[0].trim(); $('guessText').value = t[1].trim();
      applySetup(keepClues);
    }).catch(function (e) { $('packMsg').textContent = 'Could not load built-in pack (' + e.message + '). Paste or upload lists instead.'; $('setupCard').open = true; });
  }
  $('packSel').addEventListener('change', function () { loadPack($('packSel').value, false); });
  $('applyBtn').addEventListener('click', function () { applySetup(true); });
  $('savePackBtn').addEventListener('click', function () {
    var name = prompt('Name for this pack (saved in this browser only):', ''); if (!name) return;
    readCfgFromUI();
    var sp = savedPacks();
    sp[name] = { answers: $('ansText').value, guesses: $('guessText').value, cfg: { L: cfg.L, alpha: cfg.alpha, ci: cfg.ci, tok: cfg.tok, rule: cfg.rule, valid: cfg.valid } };
    try { localStorage.setItem(LS_KEY, JSON.stringify(sp)); } catch (e) { alert('Could not save (storage full?)'); return; }
    packId = 'saved:' + name; fillPackSel(); applySetup(true);
  });
  $('delPackBtn').addEventListener('click', function () {
    if (packId.indexOf('saved:') !== 0) { alert('Select a saved (★) pack first.'); return; }
    var sp = savedPacks(); delete sp[packId.slice(6)]; localStorage.setItem(LS_KEY, JSON.stringify(sp));
    packId = 'en5'; fillPackSel(); loadPack('en5', false);
  });
  function wireFile(inputId, areaId) {
    $(inputId).addEventListener('change', function () {
      var f = this.files[0]; if (!f) return;
      f.text().then(function (t) { $(areaId).value = t.trim(); packId = 'blank'; $('packSel').value = 'blank'; applySetup(false); });
      this.value = '';
    });
  }
  wireFile('ansFile', 'ansText'); wireFile('guessFile', 'guessText');

  // scoring knobs → rescore only
  [['cfgMode', 'mode'], ['cfgHard', 'hard'], ['cfgNotation', 'notation']].forEach(function (p) {
    $(p[0]).addEventListener('change', function () { cfg[p[1]] = this.value; renderClues(); if (p[0] === 'cfgNotation') { renderPreview(); renderSuggestions(lastTop); if ($('bdRows').dataset.guess) analyze($('bdRows').dataset.guess, false); } else scheduleScore(); saveState(); });
  });
  $('cfgAnsOnly').addEventListener('change', function () { cfg.ansOnly = this.checked; scheduleScore(); saveState(); });
  $('cfgMax').addEventListener('change', function () { cfg.max = Math.max(10, parseInt(this.value, 10) || 12000); scheduleScore(); saveState(); });
  $('cfgTop').addEventListener('change', function () { cfg.top = Math.max(1, Math.min(500, parseInt(this.value, 10) || 15)); scheduleScore(); saveState(); });
  $('cfgValid').addEventListener('change', function () { cfg.valid = this.value; clues.forEach(function (c) { c.note = validityNote(c.key); }); renderClues(); scheduleScore(); saveState(); });
  $('cfgRule').addEventListener('change', function () { cfg.rule = this.value; refresh(); });

  // ---------- persistence of knobs + clues ----------
  function saveState() {
    try { localStorage.setItem(LS_STATE, JSON.stringify({ packId: packId, cfg: cfg, clues: clues.map(function (c) { return { key: c.key, digits: c.digits }; }) })); } catch (e) {}
  }
  function init() {
    var st = null; try { st = JSON.parse(localStorage.getItem(LS_STATE) || 'null'); } catch (e) {}
    if (st && st.cfg) { ['mode', 'hard', 'ansOnly', 'max', 'top', 'notation'].forEach(function (k) { if (st.cfg[k] !== undefined) cfg[k] = st.cfg[k]; }); }
    var pid = st && st.packId && (st.packId.indexOf('saved:') === 0 ? savedPacks()[st.packId.slice(6)] : BUILTIN.some(function (b) { return b.id === st.packId && !b.blank; })) ? st.packId : 'en5';
    packId = pid; fillPackSel(); writeCfgToUI();
    loadPack(pid, false).then(function () {
      if (st && st.clues && st.clues.length && G) {
        st.clues.forEach(function (c) { var g = encodeGuess(c.key); if (!g.err && c.digits.length === cfg.L) clues.push({ key: g.key, ids: g.ids, syms: g.syms, digits: c.digits, pat: digitsToPat(c.digits), note: validityNote(g.key) }); });
        refresh();
      }
    });
  }
  init();
})();
