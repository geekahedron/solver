'use strict';

/* Click-level checks for the Tree page Build button.
 * Starts its own static server. Needs Chrome and puppeteer-core
 * (npm install puppeteer-core). */

const http = require('http');
const fs = require('fs');
const path = require('path');

let puppeteer;
try { puppeteer = require('/workspace/dst-map/node_modules/puppeteer-core'); }
catch (e) {
  try { puppeteer = require('puppeteer-core'); }
  catch (e2) { puppeteer = require('/tmp/pw/node_modules/puppeteer-core'); }
}

const root = path.join(__dirname, '..', 'src');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function startServer() {
  const server = http.createServer(function (req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(root, rel));
    if (file !== root && file.indexOf(root + path.sep) !== 0) {
      res.writeHead(403); res.end('no'); return;
    }
    fs.readFile(file, function (err, data) {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () { resolve(server); });
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function holdPacks(page) {
  const pending = [];
  let mode = 'hold';
  await page.setRequestInterception(true);
  page.on('request', function (req) {
    const pack = req.url().indexOf('/packs/') !== -1;
    if (pack && mode === 'hold') { pending.push(req); return; }
    if (pack && mode === 'fail') { req.abort('failed'); return; }
    req.continue();
  });
  return {
    pending: pending,
    fail: function () {
      mode = 'fail';
      pending.splice(0).forEach(function (req) { req.abort('failed'); });
    }
  };
}

async function openTree(page, base) {
  const errs = [];
  page.on('pageerror', function (e) { errs.push(e.message); });
  await page.evaluateOnNewDocument(function () { localStorage.clear(); });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(function () { return /Loading/.test(document.getElementById('packMsg').textContent); });
  await page.click('#pageModes button[data-page="tree"]');
  await page.waitForSelector('#treeBuild', { visible: true });
  return errs;
}

async function applyTiny(page) {
  await page.evaluate(function () {
    document.getElementById('ansText').value = 'slate\ntarps\ncrane\n';
    document.getElementById('guessText').value = 'slate\ntarps\ncrane\n';
    document.getElementById('applyBtn').click();
  });
}

(async function () {
  const server = await startServer();
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port + '/';
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    headless: 'new'
  });
  try {
    // Click while the built-in pack is still loading, then finish with a tiny list.
    const page = await browser.newPage();
    const gate = await holdPacks(page);
    const errs = await openTree(page, base);
    assert(gate.pending.length > 0, 'expected the pack fetch to be held');
    await page.evaluate(function () { document.getElementById('treeOpener').value = 'slate'; });
    await page.click('#treeBuild');
    const loading = await page.$eval('#treeStatus', function (el) { return el.innerHTML; });
    assert(loading.indexOf('warn') !== -1, 'loading status should be a warn: ' + loading);
    assert(loading.indexOf('still loading') !== -1, loading);
    assert(loading.indexOf('when the pack is ready') !== -1, loading);

    await applyTiny(page);
    await page.waitForFunction(function () {
      return /Built in/.test(document.getElementById('treeStatus').textContent);
    }, { timeout: 15000 });
    const built = await page.$eval('#treeWalk', function (el) { return el.textContent; });
    assert(built.indexOf('SLATE') !== -1, built);

    await page.click('#treePicks [data-pick="tarps"]');
    await page.waitForFunction(function () {
      const st = document.getElementById('treeStatus').textContent;
      const walk = document.getElementById('treeWalk').textContent;
      return /Built in/.test(st) && walk.indexOf('TARPS') !== -1;
    }, { timeout: 15000 });

    await page.evaluate(function () { document.getElementById('treeOpener').value = 'no'; });
    await page.focus('#treeOpener');
    await page.keyboard.press('Enter');
    const bad = await page.$eval('#treeStatus', function (el) { return el.textContent; });
    assert(bad.indexOf('needs 5 letters') !== -1, bad);

    await page.evaluate(function () {
      document.getElementById('treeOpener').value = 'slate';
      window.Worker = function () {
        var fake = {
          postMessage: function (msg) {
            var self = this;
            setTimeout(function () {
              if (self.onmessage) self.onmessage({ data: { type: 'error', id: msg.id, message: 'worker said boom' } });
            }, 0);
          },
          terminate: function () {},
          onmessage: null,
          onerror: null
        };
        return fake;
      };
      window.SolverCore.buildOpenerTree = function () { throw new Error('sync said boom'); };
    });
    await page.click('#treeBuild');
    await page.waitForFunction(function () {
      return /sync said boom/.test(document.getElementById('treeStatus').textContent);
    }, { timeout: 5000 });
    const boom = await page.$eval('#treeStatus', function (el) { return el.innerHTML; });
    assert(boom.indexOf('warn') !== -1, boom);
    assert(errs.length === 0, 'page errors: ' + errs.join('\n'));
    gate.fail();
    await page.close();

    // Editing the opener while setup loads cancels the queued build.
    const changed = await browser.newPage();
    const changedGate = await holdPacks(changed);
    const changedErrs = await openTree(changed, base);
    await changed.evaluate(function () { document.getElementById('treeOpener').value = 'slate'; });
    await changed.click('#treeBuild');
    await changed.evaluate(function () {
      const el = document.getElementById('treeOpener');
      el.value = 'crane';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await applyTiny(changed);
    await changed.waitForFunction(function () {
      return /Opener changed/.test(document.getElementById('treeStatus').textContent);
    }, { timeout: 5000 });
    const summary = await changed.$eval('#treeSummary', function (el) { return el.textContent; });
    assert(summary === '', 'changed opener should not build, summary=' + summary);
    assert(changedErrs.length === 0, 'page errors: ' + changedErrs.join('\n'));
    changedGate.fail();
    await changed.close();

    // A click during load, then a failed pack, must replace the loading line.
    const failed = await browser.newPage();
    const failGate = await holdPacks(failed);
    const failErrs = await openTree(failed, base);
    await failed.evaluate(function () { document.getElementById('treeOpener').value = 'slate'; });
    await failed.click('#treeBuild');
    failGate.fail();
    await failed.waitForFunction(function () {
      return /Could not load the word pack/.test(document.getElementById('treeStatus').textContent);
    }, { timeout: 5000 });
    await failed.click('#treeBuild');
    const again = await failed.$eval('#treeStatus', function (el) { return el.textContent; });
    assert(again.indexOf('Could not load the word pack') !== -1, again);
    assert(again.indexOf('when the pack is ready') === -1, again);
    const warn = await failed.$eval('#treeStatus', function (el) { return el.innerHTML; });
    assert(warn.indexOf('warn') !== -1, warn);
    assert(failErrs.length === 0, 'page errors: ' + failErrs.join('\n'));
    await failed.close();

    console.log('tree-ui ok');
  } finally {
    await browser.close();
    await new Promise(function (resolve) { server.close(resolve); });
  }
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
