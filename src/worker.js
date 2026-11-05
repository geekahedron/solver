/* Web Worker: scores candidate guesses off the UI thread. */
importScripts('core.js');
self.onmessage = function (e) {
  var d = e.data;
  var t0 = Date.now();
  var scores = SolverCore.scorePool(d.U, d.L, d.K, d.rule, d.rem, d.pool, d.isCand, function (done, total) {
    self.postMessage({ type: 'progress', id: d.id, done: done, total: total });
  });
  var top = SolverCore.rank(scores, d.mode, d.topN);
  self.postMessage({ type: 'result', id: d.id, top: top, scored: scores.length, ms: Date.now() - t0 });
};
