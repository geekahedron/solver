Geekahedron Wordle-style Solver  (https://geekahedron.com/tools/solver/)
=====================================================================
Pure client-side (HTML/CSS/JS, no backend, nothing uploaded). Files:
  index.html, style.css   page + styles
  core.js                 feedback/pattern + scoring engine (shared)
  worker.js               Web Worker that runs scoring off the UI thread
  app.js                  UI, clue entry, packs, breakdown
  packs/englishN-*.txt    built-in English packs, N = 4..8

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
Modes: fewest expected remaining (average case), most information (entropy),
smallest worst case (minimax / "guaranteed"), most patterns (splits). Ties prefer
guesses that could still be the answer.

Performance: scoring costs |pool| x |remaining|. If the guess pool is larger than
"Max guesses to score" it is pre-filtered: possible answers (up to half the budget)
plus the guesses with the best letter / position coverage of the remaining answers.
Default 12,000 means the 5-letter pack is scored exhaustively.
Single-step (greedy) scoring only — no full decision-tree search.

Pack model
----------
Built-in English lengths are one GamePack: packs/wordle-en.json next to the
word lists. It names the known answer list, the larger guess list, and Wordle
feedback. Guess mode (any / dictionary / hard / answers only) and the solution
layer (known / theoretical / known preferred) are toggles on that pack.
docs/pack-format.md in the solver repo describes the JSON shape. A Mastermind
file in packs/ is a sketch only.
