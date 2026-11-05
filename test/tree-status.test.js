'use strict';

const assert = require('assert');
const path = require('path');
const Status = require(path.join(__dirname, '..', 'src/tree-status.js'));

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('ok', name);
}

check('loading with no engine queues a visible warning', function () {
  const blocked = Status.blockReason({ hasEngine: false, packPhase: 'loading' });
  assert.strictEqual(blocked.queue, true);
  assert.ok(blocked.message.indexOf('still loading') !== -1);
  assert.ok(blocked.message.indexOf('when the pack is ready') !== -1);
});

check('a failed pack names the error and does not queue', function () {
  const blocked = Status.blockReason({ hasEngine: false, packPhase: 'failed', packError: 'HTTP 404' });
  assert.strictEqual(blocked.queue, false);
  assert.ok(blocked.message.indexOf('Could not load the word pack') !== -1);
  assert.ok(blocked.message.indexOf('HTTP 404') !== -1);
});

check('idle with no engine still warns', function () {
  const blocked = Status.blockReason({ hasEngine: false, packPhase: 'idle' });
  assert.strictEqual(blocked.queue, false);
  assert.ok(blocked.message.indexOf('still loading') !== -1);
});

check('bad and empty guesses warn', function () {
  const bad = Status.blockReason({ hasEngine: true, raw: 'no', encodeErr: 'needs 5 letters (got 2)', remaining: 3 });
  assert.strictEqual(bad.queue, false);
  assert.strictEqual(bad.message, 'needs 5 letters (got 2)');
  const empty = Status.blockReason({ hasEngine: true, raw: '', remaining: 3 });
  assert.strictEqual(empty.message, 'Type a starting guess.');
});

check('no answers warns', function () {
  const blocked = Status.blockReason({ hasEngine: true, raw: 'slate', remaining: 0 });
  assert.strictEqual(blocked.message, 'No answers left to build a tree on.');
});

check('a ready opener is not blocked', function () {
  assert.strictEqual(Status.blockReason({ hasEngine: true, raw: 'slate', remaining: 4 }), null);
});

check('queue stays current unless the user changes the opener', function () {
  assert.strictEqual(Status.queueStillCurrent({ opener: 'slate', userEdited: false }, 'slate'), true);
  assert.strictEqual(Status.queueStillCurrent({ opener: 'slate', userEdited: false }, 'SLATE'), true);
  assert.strictEqual(Status.queueStillCurrent({ opener: 'slate', userEdited: true }, 'slate'), false);
  assert.strictEqual(Status.queueStillCurrent({ opener: 'slate', userEdited: false }, 'crane'), false);
  assert.strictEqual(Status.queueStillCurrent({ opener: '', userEdited: false }, 'slate'), true);
  assert.strictEqual(Status.queueStillCurrent(null, 'slate'), false);
});

check('error text prefers the thrown message', function () {
  assert.strictEqual(Status.errorText(new Error('sync said boom')), 'sync said boom');
  assert.strictEqual(Status.errorText('worker said boom'), 'worker said boom');
  assert.strictEqual(Status.errorText({}), 'Tree build failed.');
  assert.strictEqual(Status.errorText('', 'Worker failed.'), 'Worker failed.');
});

console.log(passed + ' passed');
