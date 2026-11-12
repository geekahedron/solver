/* Parse a remote word-list file that is a JS const array, as data.
 * Never eval, Function, or script-inject the source. Quoted tokens only.
 * Browser: window.SolverListParse. Node: module.exports.
 */
(function (root) {
  'use strict';

  var ListParse = {};
  var CONST_ARRAY = /const\s+[A-Za-z_$][\w$]*\s*=\s*\[/;

  function fail(error, words) {
    return { ok: false, words: words || [], count: (words && words.length) || 0, error: error };
  }

  // source is the file body (`const name = ["CRANE", ...];`).
  // opts.length (default 5), opts.minCount, opts.maxCount, opts.maxBytes,
  // opts.caseInsensitive (default true, folds to lowercase).
  // A quoted value that is not `length` letters fails the whole file.
  ListParse.parseConstArray = function (source, opts) {
    opts = opts || {};
    var length = opts.length == null ? 5 : (opts.length | 0);
    var minCount = opts.minCount == null ? 1 : (opts.minCount | 0);
    var maxCount = opts.maxCount == null ? 0 : (opts.maxCount | 0);
    var maxBytes = opts.maxBytes == null ? 2000000 : (opts.maxBytes | 0);
    var fold = opts.caseInsensitive !== false;
    if (length < 1) return fail('Word length must be at least 1', []);
    if (source == null || source === '') return fail('Empty response', []);
    var text = String(source);
    if (text.length > maxBytes) return fail('Response is too large to be a word list', []);
    var sniff = text.slice(0, 400).replace(/^\uFEFF/, '').toLowerCase();
    if (sniff.indexOf('<!doctype') !== -1 || sniff.indexOf('<html') !== -1) {
      return fail('Response was HTML, not a word list', []);
    }
    var assign = CONST_ARRAY.exec(text);
    if (!assign) return fail('Not a const array of words', []);
    var start = text.indexOf('[', assign.index);
    var end = text.lastIndexOf(']');
    if (start < 0 || end < start) return fail('No array found', []);
    var body = text.slice(start, end + 1);
    var re = /["']([^"'\\\r\n]*)["']/g;
    var words = [];
    var seen = Object.create(null);
    var bad = 0;
    var wordOk = new RegExp('^[A-Za-z]{' + length + '}$');
    var m, raw, word;
    while ((m = re.exec(body))) {
      raw = m[1];
      if (!wordOk.test(raw)) { bad++; continue; }
      word = fold ? raw.toLowerCase() : raw;
      if (seen[word]) continue;
      seen[word] = 1;
      words.push(word);
    }
    if (bad) {
      return fail(bad + ' quoted value' + (bad === 1 ? ' is' : 's are') + ' not ' + length + ' letters', words);
    }
    if (words.length < minCount) {
      return fail('Parsed ' + words.length + ' words, expected at least ' + minCount, words);
    }
    if (maxCount && words.length > maxCount) {
      return fail('Parsed ' + words.length + ' words, above the expected maximum ' + maxCount, words);
    }
    return { ok: true, words: words, count: words.length, error: '' };
  };

  // A live fetch that did not produce a usable list. Keep a pack that is
  // already on screen. Otherwise load fallbackId (the built-in English preset).
  ListParse.choosePackFallback = function (spec) {
    spec = spec || {};
    var fallbackId = spec.fallbackId || 'en5';
    if (spec.haveReady && spec.previousId) return { action: 'keep', packId: spec.previousId };
    return { action: 'load', packId: fallbackId };
  };

  root.SolverListParse = ListParse;
  if (typeof module !== 'undefined' && module.exports) module.exports = ListParse;
})(typeof self !== 'undefined' ? self : this);
