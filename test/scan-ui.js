'use strict';
const fs = require('fs');
let puppeteer;
try { puppeteer = require('/workspace/dst-map/node_modules/puppeteer-core'); }
catch (e) { puppeteer = require('puppeteer-core'); }
const shotDir = process.env.SOLVER_SHOT_DIR || '/tmp/solver-shots';
fs.mkdirSync(shotDir, { recursive: true });
const base = process.argv[2] || 'http://127.0.0.1:18432/';

const TRAP_A = ['abc', 'abx', 'aby', 'abz', 'abw', 'def', 'aef', 'ebc', 'bac', 'cab'];
const TRAP_G = ['xyw', 'aba', 'abb', 'abd', 'abe', 'abf', 'aaa', 'bbb', 'mmm'];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function waitStatus(page, re, timeout) {
  const limit = timeout || 20000;
  const start = Date.now();
  let last = '';
  while (Date.now() - start < limit) {
    last = await page.$eval('#treeStatus', el => el.textContent);
    if (re.test(last)) return last;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('timeout waiting for ' + re + ' last=' + last);
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
  const errs = [];
  try {
    // Queue a Build click until the pack finishes loading.
    const queued = await browser.newPage();
    queued.on('pageerror', e => errs.push('queue ' + e.message));
    await queued.setRequestInterception(true);
    let releasePack;
    const gate = new Promise(r => { releasePack = r; });
    queued.on('request', req => {
      if (req.url().indexOf('wordle-en.json') !== -1) gate.then(() => req.continue()).catch(() => req.continue());
      else req.continue();
    });
    await queued.goto(base, { waitUntil: 'domcontentloaded' });
    await queued.click('#pageModes button[data-page="tree"]');
    await queued.click('#treeBuild');
    const queuedText = await queued.$eval('#treeStatus', el => el.textContent);
    assert(/still loading/.test(queuedText), 'queued build status: ' + queuedText);
    releasePack();
    const built = await waitStatus(queued, /Building tree|Built in/, 30000);
    assert(/Building tree|Built in/.test(built), 'after load: ' + built);
    await waitStatus(queued, /Built in/, 40000);
    const after = await queued.$eval('#treeStatus', el => el.textContent);
    assert(!/still loading/.test(after), 'stuck loading: ' + after);
    assert(!/Building tree/.test(after), 'stuck building: ' + after);
    await queued.close();

    const page = await browser.newPage();
    page.on('pageerror', e => errs.push('page ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push('console ' + m.text()); });
    await page.setViewport({ width: 1300, height: 1000 });
    await page.goto(base, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('remCount').textContent !== '–', { timeout: 30000 });
    await page.click('#pageModes button[data-page="tree"]');
    await page.waitForSelector('#treeScan');
    const help = await page.$eval('#treeScanHelp', el => el.textContent);
    assert(/SLATE, TARPS/.test(help) && /16 or fewer/.test(help) && /40 more/.test(help), 'help: ' + help);
    const enPicks = await page.$$eval('#treePicks [data-pick]', els => els.map(e => e.getAttribute('data-pick')));
    assert(enPicks.join(',') === 'slate,tarps,crane,cramp,trace,stare,crate,raise,alert,later', 'english picks ' + enPicks.join(','));
    const enRows = await page.$$eval('#treeOpenerTable tbody tr', rows => rows.map(r => ({
      word: r.getAttribute('data-word'),
      bits: r.children[2].textContent
    })));
    assert(enRows.length === 10 && enRows[0].word === 'slate' && /^\d\.\d\d$/.test(enRows[0].bits), 'english bits ' + JSON.stringify(enRows));
    const maxBits = Math.max.apply(null, enRows.map(r => parseFloat(r.bits)));
    assert(maxBits > parseFloat(enRows[0].bits) + 0.01, 'english list should stay in pack order, not bits order');
    const enNote = await page.$eval('#treeOpenerNote', el => el.textContent);
    assert(/in that order/.test(enNote) && /expected information/.test(enNote), enNote);
    await page.screenshot({ path: shotDir + '/scan-english-openers.png' });

    // Quick picks: SLATE before CRANE. n=1 exhausts; n=2 stops on SLATE.
    await page.select('#packSel', 'blank');
    await page.$eval('#cfgL', el => { el.value = '5'; });
    await page.$eval('#ansText', el => { el.value = 'slate\ncrane'; });
    await page.$eval('#guessText', el => { el.value = ''; });
    await page.click('#applyBtn');
    await page.waitForFunction(() => /^2\b/.test(document.getElementById('remCount').textContent));
    await page.click('#pageModes button[data-page="tree"]');
    await page.select('#treeHard', 'off');
    await page.select('#treePolicy', 'worst');
    await page.$eval('#treeBudget', el => { el.value = '1'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.click('#treeScan');
    let st = await waitStatus(page, /fits n=|None of the/);
    assert(/None of the 2 tried openers fit n=1/.test(st), 'exhaust n=1: ' + st);
    assert(/Best max depth was 2 \(SLATE\)/.test(st), 'best opener: ' + st);
    const opener1 = await page.$eval('#treeOpener', el => el.value);
    assert(opener1 === 'slate', 'shown opener ' + opener1);
    const sum1 = await page.$eval('#treeSummary', el => el.textContent);
    assert(/max depth/.test(sum1), 'tree shown on exhaust: ' + sum1);

    await page.$eval('#treeBudget', el => { el.value = '2'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.click('#treeScan');
    st = await waitStatus(page, /fits n=|None of the/);
    assert(st.indexOf('SLATE fits n=2 (max 2).') === 0, 'stop on first fit: ' + st);
    assert(!/CRANE fits/.test(st), 'did not keep scanning: ' + st);
    const sum2 = await page.$eval('#treeSummary', el => el.textContent);
    const fam2 = await page.$eval('#treeFamilies', el => el.textContent);
    assert(/max depth/.test(sum2) && /Every played answer finishes within n/.test(fam2), 'fit tree: ' + sum2 + ' / ' + fam2);
    await page.screenshot({ path: shotDir + '/scan-slate-fits.png' });

    // Custom pack, no authored openers. Starters are ranked by expected
    // information, then the small-list continuation. Wordle hard: n=3 fits
    // on XYW. n=4 stops at DEF, before that probe.
    await page.$eval('#cfgL', el => { el.value = '3'; });
    await page.$eval('#ansText', (el, v) => { el.value = v; }, TRAP_A.join('\n'));
    await page.$eval('#guessText', (el, v) => { el.value = v; }, TRAP_G.join('\n'));
    await page.click('#applyBtn');
    await page.waitForFunction(() => /^10\b/.test(document.getElementById('remCount').textContent));
    await page.click('#pageModes button[data-page="tree"]');
    await page.select('#treeGuessMode', 'dictionary');
    await page.select('#treeHard', 'wordle');
    await page.select('#treePolicy', 'worst');
    await page.$eval('#treeBudget', el => { el.value = '3'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.click('#treeScan');
    st = await waitStatus(page, /fits n=|None of the/, 30000);
    assert(st.indexOf('XYW fits n=3 (max 3).') === 0, 'hard probe fit: ' + st);
    assert((await page.$eval('#treeOpener', el => el.value)) === 'xyw', 'opener not xyw');
    const hardOn = await page.$eval('#treeHard', el => el.value);
    assert(hardOn === 'wordle', 'hard mode drifted: ' + hardOn);

    await page.$eval('#treeBudget', el => { el.value = '4'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.click('#treeScan');
    st = await waitStatus(page, /fits n=|None of the/, 30000);
    assert(st.indexOf('DEF fits n=4 (max 4).') === 0, 'hard answer fit: ' + st);
    assert(!/XYW/.test(st), 'stopped before later probe: ' + st);

    // Full English list, Wordle hard: worker stays off the UI thread, Stop and Build cancel.
    await page.select('#packSel', 'en5');
    await page.waitForFunction(() => /2[,.]?400/.test(document.getElementById('remCount').textContent), { timeout: 30000 });
    await page.click('#pageModes button[data-page="tree"]');
    await page.select('#treeHard', 'wordle');
    await page.select('#treePolicy', 'worst');
    await page.$eval('#treeBudget', el => { el.value = '6'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.evaluate(() => {
      window.__frames = 0;
      const tick = () => { window.__frames++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    await page.click('#treeScan');
    st = await waitStatus(page, /Trying/);
    assert(/SLATE/.test(st) && /1\//.test(st), 'english progress: ' + st);
    await new Promise(r => setTimeout(r, 700));
    const frames = await page.evaluate(() => window.__frames);
    assert(frames > 5, 'ui frames during scan: ' + frames);
    await page.click('#treeScan');
    st = await page.$eval('#treeStatus', el => el.textContent);
    assert(/Scan stopped/.test(st), 'stop: ' + st);
    assert(!/Trying/.test(st) && !/Building/.test(st), 'stuck after stop: ' + st);
    const label = await page.$eval('#treeScan', el => el.textContent);
    assert(label === 'Scan openers', 'button after stop: ' + label);

    await page.click('#treeScan');
    await waitStatus(page, /Trying/);
    await page.click('#treeBuild');
    st = await waitStatus(page, /Building tree/);
    assert(!/Trying/.test(st), 'build did not cancel scan: ' + st);
    st = await waitStatus(page, /Built in/, 40000);
    assert(/Built in/.test(st), 'build finished: ' + st);
    const scanLabel = await page.$eval('#treeScan', el => el.textContent);
    assert(scanLabel === 'Scan openers', 'button during finished build: ' + scanLabel);
    await page.screenshot({ path: shotDir + '/scan-english-hard.png' });

    // 4-letter English inherits the 5-letter opener list and keeps none of them.
    await page.select('#packSel', 'en4');
    await page.waitForFunction(() => /1[,.]?500/.test(document.getElementById('remCount').textContent), { timeout: 30000 });
    await page.click('#pageModes button[data-page="tree"]');
    const picks4 = await page.$$eval('#treePicks [data-pick]', els => els.map(e => e.getAttribute('data-pick')));
    assert(picks4.length === 0, 'en4 picks ' + picks4.join(','));
    const note4 = await page.$eval('#treeOpenerNote', el => el.textContent);
    assert(/none of them are legal/.test(note4), note4);

    // Dungleon has no authored list. Quick picks are real dungeon guesses,
    // ranked by expected information, and Scan openers reports those bits.
    await page.select('#packSel', 'dungleon');
    await page.waitForFunction(() => /397/.test(document.getElementById('remCount').textContent), { timeout: 30000 });
    await page.click('#pageModes button[data-page="tree"]');
    const dungPicks = await page.$$eval('#treePicks [data-pick]', els => els.map(e => e.getAttribute('data-pick')));
    assert(dungPicks.length === 10, 'dungleon picks ' + dungPicks.join(','));
    assert(dungPicks[0] === 'AWSCw', 'dungleon top ' + dungPicks[0]);
    assert(dungPicks.indexOf('slate') < 0 && dungPicks.indexOf('tarps') < 0, 'wordle openers on dungleon');
    assert(/[A-Z]/.test(dungPicks[0]) && /[a-z]/.test(dungPicks[0]), 'dungleon case ' + dungPicks[0]);
    const dungRows = await page.$$eval('#treeOpenerTable tbody tr', rows => rows.map(r => ({
      word: r.getAttribute('data-word'),
      bits: r.children[2].textContent
    })));
    assert(dungRows.length === 10 && dungRows[0].word === 'AWSCw', JSON.stringify(dungRows[0]));
    for (let i = 1; i < dungRows.length; i++) {
      assert(parseFloat(dungRows[i].bits) <= parseFloat(dungRows[i - 1].bits) + 1e-9, 'bits order ' + JSON.stringify(dungRows));
    }
    const dungNote = await page.$eval('#treeOpenerNote', el => el.textContent);
    assert(/no opener list/.test(dungNote) && /expected information/.test(dungNote), dungNote);
    await page.select('#treeHard', 'off');
    await page.select('#treePolicy', 'worst');
    await page.$eval('#treeBudget', el => { el.value = '6'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.click('#treeScan');
    st = await waitStatus(page, /Trying/);
    assert(/AWSCw/.test(st) && /bits/.test(st) && /1\/10/.test(st), 'dungleon scan ' + st);
    await page.click('#treeScan');
    st = await page.$eval('#treeStatus', el => el.textContent);
    assert(/Scan stopped/.test(st), 'dungleon stop ' + st);
    await page.screenshot({ path: shotDir + '/scan-dungleon-openers.png' });

    // Mobile: controls stay on screen and a tiny scan still completes.
    const mobile = await browser.newPage();
    mobile.on('pageerror', e => errs.push('mobile ' + e.message));
    await mobile.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone)' });
    await mobile.goto(base, { waitUntil: 'networkidle0' });
    await mobile.waitForFunction(() => document.getElementById('remCount').textContent !== '–', { timeout: 30000 });
    await mobile.click('#pageModes button[data-page="tree"]');
    await mobile.select('#packSel', 'blank');
    await mobile.$eval('#cfgL', el => { el.value = '5'; });
    await mobile.$eval('#ansText', el => { el.value = 'slate\ncrane'; });
    await mobile.$eval('#guessText', el => { el.value = ''; });
    await mobile.click('#applyBtn');
    await mobile.waitForFunction(() => /^2\b/.test(document.getElementById('remCount').textContent));
    await mobile.click('#pageModes button[data-page="tree"]');
    await mobile.select('#treeHard', 'off');
    const box = await mobile.evaluate(() => {
      const b = document.getElementById('treeScan').getBoundingClientRect();
      const s = document.getElementById('treeStatus').getBoundingClientRect();
      return { bw: b.width, bh: b.height, sx: s.x, sw: s.width, vw: window.innerWidth };
    });
    assert(box.bw > 40 && box.bh > 20, 'scan button box ' + JSON.stringify(box));
    assert(box.sx >= -1 && box.sx + Math.min(box.sw, 20) <= box.vw + 1, 'status offscreen ' + JSON.stringify(box));
    await mobile.$eval('#treeBudget', el => { el.value = '2'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await mobile.click('#treeScan');
    st = await waitStatus(mobile, /SLATE fits n=2/);
    assert(/SLATE fits n=2 \(max 2\)/.test(st), 'mobile fit: ' + st);
    await mobile.screenshot({ path: shotDir + '/scan-mobile.png' });

    console.log('errs', errs);
    const realErrs = errs.filter(e => !/favicon/i.test(e));
    assert(!realErrs.length, 'page errors ' + realErrs.join(' | '));
    console.log('scan ui ok');
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
