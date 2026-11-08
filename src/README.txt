Geekahedron Wordle-style Solver  (https://geekahedron.com/tools/solver/)
=====================================================================
Pure client-side (HTML/CSS/JS, no backend, nothing uploaded). Files:
  index.html, style.css   page + styles
  core.js                 feedback/pattern + scoring engine (shared)
  tree.js                 opener solve tree (one starting guess, then the policy)
  worker.js               Web Worker that runs scoring and opener trees off the UI thread
  app.js                  UI, clue entry, packs, breakdown, tree page
  packs/englishN-*.txt    built-in English packs, N = 4..8
  packs/dungleon.json     Dungleon pack (known list + generated rules)

Word lists / attribution
------------------------
* Guess lists (packs/englishN-guesses.txt): every N-letter word in ENABLE
  (Enhanced North American Benchmark LExicon, ENABLE2K), which is in the
  public domain. Copy used: https://github.com/dolph/dictionary (enable1.txt).
* Answer lists (packs/englishN-answers.txt): a subset of the same ENABLE words
  (no simple -s / -ed inflections, a few slurs/obscenities removed), ranked by
  frequency using Peter Norvig's count_1w.txt (https://norvig.com/ngrams/,
  derived from the Google Web Trillion Word Corpus). Only the ranking was used;
  the shipped lists contain ENABLE words only. 5-letter: 2,400 answers / 8,636 guesses.
* These are NOT the official NYT Wordle lists. Paste or upload any lists you like
  (Setup -> answer list / extra guess list); save them as a named pack in your browser.

Scoring
-------
For a guess g and the set S of answers still possible, answers are partitioned
by the feedback pattern they would produce. Reported metrics:
  Exp. left  = sum(|bucket|^2)/|S|, with the all-green bucket counted as 0
  Worst      = largest bucket (excluding all-green)
  Patterns   = number of non-empty buckets
  Bits       = Shannon entropy of the bucket distribution
  Steps      = expected guesses until the secret is found (this guess counts as 1;
               all-green adds 0; each remaining answer is equally likely)
  Worst      = largest one-ply pattern group. It is not Max steps.
  Max steps  = worst-case further guesses to finish every remaining answer,
               including the guess being scored
Modes: fewest expected steps to solve, fewest expected remaining (average case),
most information (entropy), smallest worst case (minimax, one ply), most
patterns (splits). Ties prefer guesses that could still be the answer.

Steps follows the active guess mode and hard-mode rules on later plies. Sets of
2–3 answers use a closed form.
Exact through 5 answers (at most 64 guesses tried at one of those nodes). A dictionary larger than 280 is cut to that many probes for the whole search, and the answers still in the set are always added back. Every guess in the pool is valued when at most 40 answers remain and the pool has at most 20000 rows; above that, deepen a beam of 18 expected-remaining, 6 entropy, and 6 worst-case guesses. Larger sets continue with the top 1 one-ply pick from 40 candidates.
The page marks those values with ≈. Guesses outside the beam show –.
No frequency weights. These are not the NYT lists, so openings will not match
Wordlebot.

Guarantee (Analysis checkbox)
-----------------------------
Max steps is the worst-case number of further guesses needed to finish every
remaining answer, including the guess being scored. Answers are weighted
uniformly. Every later guess uses the active guess mode and hard-mode rules
(Wordle hard or strict), the same continuation rules as expected steps. Guess
mode "any" does not invent strings outside the loaded lists.

When the box is checked, the selected scoring mode — including fewest expected
steps — ranks only guesses for which a line with Max steps ≤ n is proved.
Survivors stay in that mode's order. n defaults to 6 minus clues already entered
(a Wordle budget) until you edit it.

The Max steps search is exact while 16 or fewer answers remain (or the legal
guess list fits in its beam). On longer lists it tries a letter-coverage beam,
a node cap, and a short time cap. That pass is fail-closed: a missing line
refuses the guess and never reports a guarantee that was not proved. A proved
but possibly non-optimal line is shown as ≤k. "≥k?" means the search could not
prove a number. Guessing a still-possible answer until it hits is a real
strategy, so Max steps ≤ (answers left) can be proved even when the beam is empty.

Performance: one-ply scoring costs |pool| x |remaining|. If the guess pool is
larger than "Max guesses to score" it is pre-filtered: possible answers (up to
half the budget) plus the guesses with the best letter / position coverage of
the remaining answers. Default 12,000 means the 5-letter pack's one-ply pass is
exhaustive. That same cap limits which openers the steps beam can deepen.
The Max steps search is capped separately.

Opener solve tree (Tree page)
-----------------------------
Fixes one starting guess and expands the decision tree on the answers still
possible. Each pattern shows the next guess and the remaining words, in the
same shape as Jonathan Olson's solver
(https://jonathanolson.net/wordle-solver/). It is not his precomputed NYT tree.

Differences from Olson:
* Built-in lists are ENABLE subsets, not the NYT Wordle list. SALET and SOARE
  are not in them. TARPS is on the guess list. CRAMP is an answer here.
* Uniform answer weights. No frequency prior.
* Built in the browser for the active list, guess mode, solution layer, and
  hard-mode rules. n starts at 6 minus clues already entered.
* "Guaranteed" is fail-closed: every answer played out within n, and every
  later guess chosen by a full search. A shortlist line that finishes within n
  is a real strategy and is labeled as such, without that stronger claim.
* Hard mode on a long list picks later guesses from a letter-coverage
  shortlist. Depths are exact for the guesses actually played. Answers over n
  broke this strategy; a different continuation might still fit, and the page
  does not treat that as proved. A branch cut off by the time limit is unproved.
* The Analysis guarantee checkbox is unchanged. It still refuses a guess when
  a full line was not proved. Tree does not rank every opener.
* Scan openers tries the quick picks in the order shown (SLATE through LATER,
  skipping any missing from the pack) and stops at the first played strategy
  with max depth ≤ n. That is strategyFits, not the stronger guaranteed flag.
  With 16 or fewer answers left it also tries those answers, then other
  dictionary guesses, then ruled-out answers, up to 40 more. Build tree or a
  new scan cancels it. A click before the pack has loaded waits for the list.

Policies: worst-case depth, or fewest expected steps. The summary shows max
depth, how many answers exceed n, and the average for this fixed opener.

Pack model
----------
Built-in English lengths are one GamePack: packs/wordle-en.json next to the
word lists. It names the known answer list, the larger guess list, and Wordle
feedback. Guess mode (any / dictionary / hard / answers only) and the solution
layer (known / theoretical / known preferred) are toggles on that pack.
docs/pack-format.md in the solver repo describes the JSON shape. A Mastermind
file in packs/ is a sketch only.
