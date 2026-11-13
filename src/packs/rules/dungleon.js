// Dungleon pack script.
// Loaded when the pack sets "rules": "script:rules/dungleon.js".
//
// Feedback matches the live client's stage confirm (marks r, y, Y, g, G).
// A mark is plus (Y or G) when the secret has more copies of that piece
// than the guess. Every non-absent tile of that piece is plus; a red tile
// never is, because an extra secret copy means every guess copy matched.
// Greens are taken first, then yellows left to right. This is not a
// left-to-right running count of copies seen so far: that count misses an
// extra copy sitting to the right of the matched tile, so AWSCw against
// ?WSCS was scored rgggr instead of rgGgr and the guess eliminated every
// dungeon. The older dungleon.pm get_clue wrote "+" beside the mark.
//
// Theoretical solutions are generate_solutions from dungleon.pm: per-slot
// alphabets, the filters below, then frogging and zombification. The cake/mimic
// script dungleon-generator.pl is a separate experiment (it keeps only cakes)
// and is not this generator. solver.pl counts Z as a monster for archive
// totals; frogging uses dungleon.pm's monster list, which does not include Z.
// Z is only produced when a necromancer zombifies heroes.
//
// feedbackKind 'custom' tells the engine to score with this feedback instead
// of the Wordle base-3 pattern.

exports.feedbackKind = 'custom';

var ABSENT = 0;
var PRESENT = 1;
var CORRECT = 2;
var PRESENT_PLUS = 3;
var CORRECT_PLUS = 4;
var BASE = 5;

var MONSTERS = { B: 1, S: 1, s: 1, D: 1, T: 1, N: 1, O: 1, o: 1, w: 1, t: 1 };

var SLOTS = [
  ['W', 'A', 'M', 'K', 'V', 'C', 'c', 't'],
  ['W', 'A', 'M', 'V', 'C', 'c', 'B', 'S', 's', 'D', 'T', 'N', 'O', 'o'],
  ['C', 'c', 'B', 'S', 's', 'D', 'T', 'N', 'O', 'o'],
  ['C', 'c', 'B', 'S', 's', 'D', 'N', 'O', 'o'],
  ['C', 'c', 'R', 'B', 'S', 's', 'D', 'N', 'O', 'o', 'w']
];

var SOLO_DUP = /([WAMKVDTNOowtR]).*\1/;
var ARCHER_MONSTER = /A[BSsDNOo]/;
var WARRIOR_BLOCKED = /W[WAMVCc]/;
var BATS_OK = /^[^B]*$|[WAM]BBBB|^[^B]*B[^B]*B[^B]*$/;
var SPIDERS_OK = /^[^s]*$|^[^s]*s[^s]*s[^s]*s[^s]*$/;
var DRAGON_OK = /^[^D]*$|^[^BSsTNOowt]*$/;
var ORC_ALONE = /^[^o]*O[^o]*$/;
var GOBLIN_ALONE = /^[^O]*o[^O]*$/;
var ONE_COIN = /^[^c]*c[^c]*$/;
var TROLL_TREASURE = /[CcR].*T|T.*[CcR]/;
var TROLL_BEHIND = /[^WAMKV]T/;
var DRAGON_COIN = /c.*D|D.*c/;
var DRAGON_CHEST5 = /D.*C$/;

var built = null;

// Scratch for feedbackIds. Ids are small; grow if a pack ever exceeds this.
var SL = new Int16Array(256);
var USED = new Uint16Array(16);
var MARK = new Int16Array(8);

function ensureId(id) {
  if (id < SL.length) return;
  var n = SL.length;
  while (n <= id) n *= 2;
  var s2 = new Int16Array(n);
  s2.set(SL);
  SL = s2;
}

function consumeFirst(list, token) {
  var i;
  for (i = 0; i < list.length; i++) {
    if (list[i] !== token) continue;
    list.splice(i, 1);
    return true;
  }
  return false;
}

function clueDigits(guess, secret) {
  var L = guess.length;
  var clue = new Array(L);
  var left = [];
  var guessCount = Object.create(null);
  var secretCount = Object.create(null);
  var i, g, s, more;
  for (i = 0; i < L; i++) {
    g = guess[i];
    s = secret[i];
    left.push(s);
    guessCount[g] = (guessCount[g] || 0) + 1;
    secretCount[s] = (secretCount[s] || 0) + 1;
    clue[i] = g === s ? CORRECT : -1;
  }
  for (i = 0; i < L; i++) if (clue[i] === CORRECT) consumeFirst(left, guess[i]);
  for (i = 0; i < L; i++) {
    if (clue[i] !== -1) continue;
    g = guess[i];
    clue[i] = consumeFirst(left, g) ? PRESENT : ABSENT;
  }
  for (i = 0; i < L; i++) {
    g = guess[i];
    more = (secretCount[g] || 0) > (guessCount[g] || 0);
    if (!more) continue;
    if (clue[i] === CORRECT) clue[i] = CORRECT_PLUS;
    else if (clue[i] === PRESENT) clue[i] = PRESENT_PLUS;
  }
  return clue;
}

function patOf(digits) {
  var p = 0, m = 1, i;
  for (i = 0; i < digits.length; i++, m *= BASE) p += digits[i] * m;
  return p;
}

exports.feedback = function (guess, secret) {
  var digits = clueDigits(guess, secret);
  return { shape: 'perSlot', digits: digits, pat: patOf(digits) };
};

// Hot path used by remaining-set checks and Analysis. Same marks as feedback.
// SL holds unconsumed secret copies. After greens and yellows, a leftover
// copy means the secret had more of that piece than the guess.
exports.feedbackIds = function (g, go, a, ao, L) {
  var n = 0, i, gs, ss, p = 0, m = 1;
  for (i = 0; i < L; i++) {
    gs = g[go + i];
    ss = a[ao + i];
    ensureId(gs);
    ensureId(ss);
    if (SL[ss] === 0) USED[n++] = ss;
    SL[ss]++;
    MARK[i] = gs === ss ? CORRECT : -1;
  }
  for (i = 0; i < L; i++) {
    if (MARK[i] !== CORRECT) continue;
    SL[g[go + i]]--;
  }
  for (i = 0; i < L; i++) {
    if (MARK[i] !== -1) continue;
    gs = g[go + i];
    if (SL[gs] > 0) {
      MARK[i] = PRESENT;
      SL[gs]--;
    } else MARK[i] = ABSENT;
  }
  for (i = 0; i < L; i++) {
    gs = g[go + i];
    if (SL[gs] > 0) {
      if (MARK[i] === CORRECT) MARK[i] = CORRECT_PLUS;
      else if (MARK[i] === PRESENT) MARK[i] = PRESENT_PLUS;
    }
    p += MARK[i] * m;
    m *= BASE;
  }
  for (i = 0; i < n; i++) SL[USED[i]] = 0;
  return p;
};

function passesFilters(word) {
  if (!/[WAM]/.test(word)) return false;
  if (!/[BSsDTNOowt]/.test(word)) return false;
  if (SOLO_DUP.test(word)) return false;
  if (ARCHER_MONSTER.test(word)) return false;
  if (WARRIOR_BLOCKED.test(word)) return false;
  if (!BATS_OK.test(word)) return false;
  if (!SPIDERS_OK.test(word)) return false;
  if (!DRAGON_OK.test(word)) return false;
  if (ORC_ALONE.test(word)) return false;
  if (GOBLIN_ALONE.test(word)) return false;
  if (ONE_COIN.test(word)) return false;
  if (TROLL_TREASURE.test(word)) return false;
  if (TROLL_BEHIND.test(word)) return false;
  if (DRAGON_COIN.test(word)) return false;
  if (DRAGON_CHEST5.test(word)) return false;
  return true;
}

function zombify(word) {
  return word.replace(/[WAM]/g, 'Z');
}

function generateList() {
  var results = [];
  var s0 = SLOTS[0], s1 = SLOTS[1], s2 = SLOTS[2], s3 = SLOTS[3], s4 = SLOTS[4];
  var i0, i1, i2, i3, i4, word;
  for (i0 = 0; i0 < s0.length; i0++) {
    for (i1 = 0; i1 < s1.length; i1++) {
      for (i2 = 0; i2 < s2.length; i2++) {
        for (i3 = 0; i3 < s3.length; i3++) {
          for (i4 = 0; i4 < s4.length; i4++) {
            word = s0[i0] + s1[i1] + s2[i2] + s3[i3] + s4[i4];
            if (passesFilters(word)) results.push(word);
          }
        }
      }
    }
  }
  var seen = Object.create(null);
  var out = [];
  var i, p, cp, mod;
  for (i = 0; i < results.length; i++) {
    word = results[i];
    if (word.indexOf('M') === -1) {
      if (!seen[word]) { seen[word] = 1; out.push(word); }
      continue;
    }
    for (p = 0; p < 5; p++) {
      cp = word.charAt(p);
      if (!MONSTERS[cp]) continue;
      mod = word.substring(0, p) + 'F' + word.substring(p + 1);
      if (cp === 'N') mod = zombify(mod);
      if (!seen[mod]) { seen[mod] = 1; out.push(mod); }
    }
  }
  var finalList = [];
  var finalSeen = Object.create(null);
  for (i = 0; i < out.length; i++) {
    word = out[i];
    if (word.indexOf('N') !== -1) word = zombify(word);
    if (!finalSeen[word]) { finalSeen[word] = 1; finalList.push(word); }
  }
  finalList.sort();
  return finalList;
}

function build() {
  if (built) return built;
  var list = generateList();
  built = { list: list, set: new Set(list) };
  return built;
}

exports.generateSolutions = function () {
  return build().list.slice();
};

exports.validGuess = function (word, ctx) {
  return ctx.structural(word);
};

exports.validSolution = function (word) {
  if (!word || word.length !== 5) return false;
  var s = typeof word === 'string' ? word : word.join('');
  return build().set.has(s);
};

exports.consistent = function (guess, clue, secret, ctx) {
  var fb = exports.feedback(guess, secret);
  var pat = ctx && ctx.cluePattern ? ctx.cluePattern(clue) : null;
  return fb.pat === pat;
};
