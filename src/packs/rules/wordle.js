// Reference pack script for Wordle-style list games.
// Loaded only when a pack sets "rules": "script:rules/wordle.js".
// The English presets use "builtin:wordle" instead, which is the same contract.
//
// The host evaluates this file as a function body with `module` and `exports`.
// ctx is the SolverEngine (structural, inLists, pattern, cluePattern, pack).

exports.validGuess = function (word, ctx) {
  return ctx.structural(word) && ctx.inLists(word);
};

exports.validSolution = function (word, ctx) {
  return ctx.structural(word) && ctx.inLists(word);
};

exports.consistent = function (guess, clue, secret, ctx) {
  return ctx.pattern(guess, secret) === ctx.cluePattern(clue);
};

exports.feedback = function (guess, secret, ctx) {
  var pat = ctx.pattern(guess, secret);
  var digits = [];
  var p = pat;
  var i;
  for (i = 0; i < ctx.pack.length; i++) { digits.push(p % 3); p = Math.floor(p / 3); }
  return { shape: 'perSlot', pat: pat, digits: digits };
};
