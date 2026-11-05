const puppeteer = require('/workspace/dst-map/node_modules/puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
  const errs = [];
  const p = await b.newPage();
  p.on('console', m => { if (['error','warning'].includes(m.type())) errs.push(m.text()); });
  p.on('pageerror', e => errs.push('pageerror ' + e.message));
  await p.setViewport({ width: 1300, height: 1000 });
  const base = process.argv[2] || 'http://127.0.0.1:18432/';
  await p.goto(base, { waitUntil: 'networkidle0' });
  await p.waitForFunction(() => /Scored/.test(document.getElementById('scoreStatus').textContent), { timeout: 60000 });
  const out = async (tag) => console.log(tag, JSON.stringify(await p.evaluate(() => ({
    rem: document.getElementById('remCount').textContent, st: document.getElementById('scoreStatus').textContent,
    top: [...document.querySelectorAll('#sugTable tbody tr')].slice(0,5).map(r => [...r.cells].map(c=>c.textContent).join(' ')),
    bd: document.getElementById('bdSummary').textContent, rows: document.querySelectorAll('.bd-row').length }))));
  await out('open');
  await p.screenshot({ path: '/workspace/solver/shot-open.png', fullPage: false });
  for (const m of ['minimax','entropy','splits']) { await p.select('#cfgMode', m); await new Promise(s=>setTimeout(s,300)); await p.waitForFunction(() => /Scored/.test(document.getElementById('scoreStatus').textContent), { timeout: 60000 }); await out(m); }
  await p.select('#cfgMode','avg');
  await p.type('#clueGuess', 'slate'); await p.type('#cluePat', 'rgyrr'); await p.click('#addClueBtn');
  await new Promise(s=>setTimeout(s,300)); await p.waitForFunction(() => /Scored/.test(document.getElementById('scoreStatus').textContent));
  await out('after slate rgyrr');
  await p.select('#cfgHard','wordle'); await new Promise(s=>setTimeout(s,300)); await p.waitForFunction(() => /Scored/.test(document.getElementById('scoreStatus').textContent));
  await out('hard');
  await p.type('#bdFilter', 'bbbbb'); await new Promise(s=>setTimeout(s,200));
  await out('filter');
  await p.screenshot({ path: '/workspace/solver/shot-clue.png', fullPage: true });
  const m = await b.newPage();
  await m.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone)' });
  await m.goto(base, { waitUntil: 'networkidle0' });
  await m.waitForFunction(() => /Scored/.test(document.getElementById('scoreStatus').textContent), { timeout: 60000 });
  await m.screenshot({ path: '/workspace/solver/shot-mobile.png', fullPage: false });
  console.log('errs', errs);
  await b.close();
})();
