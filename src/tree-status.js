/* Messages for the Tree page Build button.
 * Browser: window.SolverTreeStatus. Node: module.exports.
 *
 * runTree consults this before starting a search so a click with no pack,
 * a bad opener, or an empty answer list always leaves a visible warning.
 */
(function (root) {
  'use strict';

  function errorText(err, fallback) {
    var fb = fallback == null ? 'Tree build failed.' : fallback;
    if (typeof err === 'string' && err) return err;
    if (err && err.message) return String(err.message);
    return fb;
  }

  function blockReason(opts) {
    opts = opts || {};
    if (!opts.hasEngine) {
      if (opts.packPhase === 'loading') {
        return {
          queue: true,
          message: 'Game setup is still loading. The tree will build when the pack is ready.'
        };
      }
      if (opts.packPhase === 'failed') {
        var detail = opts.packError ? ' (' + opts.packError + ')' : '';
        return {
          queue: false,
          message: 'Could not load the word pack' + detail + '. Paste or upload lists in Game setup.'
        };
      }
      return { queue: false, message: 'Game setup is still loading.' };
    }
    if (!opts.raw || opts.encodeErr) {
      return { queue: false, message: opts.encodeErr || 'Type a starting guess.' };
    }
    if (!opts.remaining) {
      return { queue: false, message: 'No answers left to build a tree on.' };
    }
    return null;
  }

  // A queued Build runs after the pack loads unless the user edited the opener.
  // An empty field filled by the suggested opener is still the same request.
  function queueStillCurrent(queued, openerNow) {
    if (!queued || queued.userEdited) return false;
    var now = String(openerNow == null ? '' : openerNow).trim();
    var want = String(queued.opener == null ? '' : queued.opener).trim();
    if (now.toLowerCase() === want.toLowerCase()) return true;
    return !want && !!now;
  }

  var api = {
    errorText: errorText,
    blockReason: blockReason,
    queueStillCurrent: queueStillCurrent,
    openerChanged: 'Opener changed while setup was loading. Click Build tree again.'
  };
  root.SolverTreeStatus = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
