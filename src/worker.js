/* Web Worker: scores candidate guesses, and builds opener trees, off the UI thread. */
importScripts('core.js', 'tree.js');
self.onmessage = function (e) {
  var d = e.data;
  if (d.type === 'tree') {
    var tTree = Date.now();
    try {
      var tree = SolverCore.buildOpenerTree(d, function (done, total, nodes) {
        self.postMessage({ type: 'progress', id: d.id, done: done, total: total, nodes: nodes, phase: 'tree' });
      });
      self.postMessage({ type: 'tree', id: d.id, tree: tree, ms: Date.now() - tTree });
    } catch (err) {
      self.postMessage({
        type: 'error',
        id: d.id,
        message: (err && err.message) ? String(err.message) : 'Tree build failed.'
      });
    }
    return;
  }
  var t0 = Date.now();
  var scores = SolverCore.scorePool(d.U, d.L, d.K, d.rule, d.rem, d.pool, d.isCand, function (done, total) {
    self.postMessage({ type: 'progress', id: d.id, done: done, total: total, phase: 'ply' });
  });
  if (d.mode === 'steps') {
    var s = d.steps || {};
    SolverCore.attachExpectedSteps(scores, d.U, d.L, d.K, d.rule, d.rem, d.pool, {
      guessMode: s.guessMode,
      hard: s.hard,
      dict: s.dict,
      clues: s.clues || [],
      onProgress: function (done, total) {
        self.postMessage({ type: 'progress', id: d.id, done: done, total: total, phase: 'steps' });
      }
    });
    d.stepsAttached = true;
  }
  var finished = SolverCore.finishScores(scores, d, function (done, total) {
    self.postMessage({ type: 'progress', id: d.id, done: done, total: total, phase: 'depth' });
  });
  self.postMessage({
    type: 'result', id: d.id, top: finished.top, scored: scores.length,
    ms: Date.now() - t0, depth: finished.depth
  });
};
