let puppeteer;
try { puppeteer = require('/workspace/dst-map/node_modules/puppeteer-core'); }
catch (e) { puppeteer = require('puppeteer-core'); }
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: 'new' });
  const p = await b.newPage(); const errs=[];
  p.on('pageerror', e => errs.push('pageerror ' + e.message));
  await p.goto('http://127.0.0.1:18432/', { waitUntil: 'networkidle0' });
  await p.evaluate(()=>localStorage.clear()); await p.reload({ waitUntil: 'networkidle0' });
  await p.waitForFunction(() => /Scored/.test(document.getElementById('scoreStatus').textContent));
  // use button on breakdown
  await p.click('.bd-row [data-use]'); await new Promise(s=>setTimeout(s,400));
  await p.waitForFunction(() => /Scored/.test(document.getElementById('scoreStatus').textContent));
  console.log(await p.evaluate(()=>document.getElementById('clueList').textContent+' | '+document.getElementById('remCount').textContent+' | '+document.getElementById('bdSummary').textContent));
  await p.select('#packSel','tokens'); await new Promise(s=>setTimeout(s,300));
  await p.evaluate(()=>{ document.getElementById('cfgL').value=3; document.getElementById('ansText').value='AS KH 10D\nQS QH 2C\nAS 2C KH\n10D QS AS\nKH KH 2C'; });
  await p.click('#applyBtn'); await new Promise(s=>setTimeout(s,500));
  await p.waitForFunction(() => /Scored/.test(document.getElementById('scoreStatus').textContent));
  await p.type('#clueGuess','AS KH 10D'); await p.type('#cluePat','gyb'); await p.click('#addClueBtn'); await new Promise(s=>setTimeout(s,500));
  console.log(await p.evaluate(()=>[document.getElementById('packMsg').textContent, document.getElementById('remCount').textContent, document.getElementById('scoreStatus').textContent, [...document.querySelectorAll('#sugTable tbody tr')].map(r=>r.cells[1].textContent).join(','), document.getElementById('bdSummary').textContent].join(' | ')));
  await p.evaluate(()=>localStorage.clear());
  console.log(errs); await b.close();
})();
