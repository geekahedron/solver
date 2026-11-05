# Solver

Client-side Wordle-style solver. Enter guesses and color clues; it lists the answers still possible and ranks the next guess by expected steps to solve, or by the one-ply scores Wordlebot also shows (expected remaining, entropy, worst case, and pattern splits).

The live page is [https://geekahedron.com/tools/solver/](https://geekahedron.com/tools/solver/).

Everything runs in the browser. There is no server, and nothing you type is uploaded.

## Open locally

The site is the static files in `src/`.

From the repo root:

```bash
python3 -m http.server 18432 --directory src
```

Then open [http://127.0.0.1:18432/](http://127.0.0.1:18432/).

Built-in word lists load with `fetch`, which browsers block from `file://`. Use a local static server for the English packs. Pasting or uploading your own lists works either way. Scoring uses a Web Worker over http; on `file://` it falls back to the main thread.

## Word lists

The built-in English packs (4–8 letters) are **not** the New York Times Wordle lists.

- Guess lists (`src/packs/englishN-guesses.txt`): every N-letter word in ENABLE (Enhanced North American Benchmark Lexicon), which is in the public domain. The copy used to build them is [dolph/dictionary](https://github.com/dolph/dictionary) `enable1.txt`.
- Answer lists (`src/packs/englishN-answers.txt`): a subset of those ENABLE words (simple `-s` / `-ed` inflections dropped, a few slurs removed), ranked with Peter Norvig’s [`count_1w.txt`](https://norvig.com/ngrams/). Only that frequency ranking was used. The shipped lists contain ENABLE words only.

`build_lists.py` regenerates the packs when ENABLE and `count_1w.txt` are available at the paths it expects. Metric definitions and file notes are in `src/README.txt`.

## Layout

| Path | Role |
| --- | --- |
| `src/index.html`, `src/style.css` | Page |
| `src/core.js` | Feedback patterns and scoring (shared with the worker) |
| `src/tree.js` | Opener solve tree (one starting guess, then the whole policy) |
| `src/pack.js` | GamePack parsing, clue alphabets, validators |
| `src/engine.js` | Pools, history, guess modes, solution layers |
| `src/renderers.js` | `tokenRenderer` / `clueRenderer` ids |
| `src/worker.js` | Scoring off the UI thread |
| `src/app.js` | Clues, packs, breakdown |
| `src/packs/wordle-en.json` | English 4–8 pack (points at the list files) |
| `src/packs/englishN-*.txt` | Built-in lists, N = 4..8 |
| `src/packs/rules/wordle.js` | Optional validator script (the presets use the builtin) |
| `docs/pack-format.md` | Pack JSON shape |

Deploy the files in `src/` as static assets (for example `public_html/tools/solver/`). No build step and no server.

## Game pack

One pack describes a game. The page then toggles how you play it:

- **Guess mode** — `any`, `dictionary`, `hard` (the candidate must fit every clue), or `answersOnly`. Wordle hard (reuse greens and yellows) is a separate, weaker switch.
- **Solution layer** — score **known** answers, the larger **theoretical** list (the dictionary, for English), or **known preferred** (known while any remain, otherwise theoretical). Scenario shows both lists.
- **Page** — Scenario (remaining lists), Analysis (pattern partitions and scores), Tree (one opener’s solve tree), or both.
- **Guarantee** — on Analysis, keep only guesses that can be proved to finish every remaining answer in at most n further guesses (default 6 minus clues entered), under the same guess mode and hard-mode rules on every later step. Max steps is that multi-ply worst case. The one-ply Worst column is unchanged. When scoring is fewest expected steps, survivors stay ordered by that average.

The English presets are that one pack: `src/packs/wordle-en.json`, the ENABLE lists, and Wordle `consistent` / feedback. Custom paste and upload still build a pack in the browser. Dungleon, Purrdle, and Mastermind are not playable here; `src/packs/mastermind-sketch.json` only reserves the shape. Details are in [docs/pack-format.md](docs/pack-format.md).

## Expected steps

**Fewest expected steps to solve** ranks a guess by the average number of further guesses until the secret is named. The secret is uniform over the answers still possible — there is no frequency prior. The guess being scored counts as 1. All-green adds nothing more. Any other reply adds the expected guesses needed to finish that smaller set. Later guesses are chosen from the pool the active guess mode and hard-mode rules would actually allow (dictionary, answers only, strict consistency, or Wordle hard).

On a handmade list small enough to sit under the limits below, that number is the exact tree (sets of 2 and 3 answers have a closed form: 1.5 for a pair when either answer is legal, 5/3 when a guess separates all three and hits, otherwise 2). A solved-in-one secret contributes 1.

Openings are not that tree. Exact through 5 answers (at most 64 guesses tried at one of those nodes). A dictionary larger than 280 is cut to that many probes for the whole search, and the answers still in the set are always added back. Every guess in the pool is valued when at most 40 answers remain and the pool has at most 20000 rows; above that, deepen a beam of 18 expected-remaining, 6 entropy, and 6 worst-case guesses. Larger sets continue with the top 1 one-ply pick from 40 candidates. The page marks those values with ≈. Guesses outside the beam stay blank (–), so a guess that loses on every one-ply metric can be missed. Letter-coverage cuts keep remaining answers first, then the guesses that touch the most common letters. “Max guesses to score” still limits which openers enter the beam.

These lists are not the New York Times Wordle lists, and the prior is uniform, so an English opening will not match Wordlebot’s published average.

## Opener solve tree

The **Tree** page fixes one starting guess (SLATE, TARPS, CRANE, or anything you type) and expands a decision tree on the answers still possible. Each feedback pattern shows the policy’s next guess and the words left in that branch. That is the same shape as [Jonathan Olson’s solver](https://jonathanolson.net/wordle-solver/): opener, coloring, next guess. It is not his precomputed NYT Wordle tree.

- The built-in packs are ENABLE subsets, not the New York Times list. SALET and SOARE are not in them. TARPS is on the guess list. CRAMP is on the answer list.
- Answers are equally likely. There is no frequency prior.
- The tree uses the active guess mode, solution layer, and hard-mode rules on every later guess. Clues already entered shrink the list. **n** starts at 6 minus clues entered.
- Depth is how many guesses this strategy plays, including the opener. Answers over **n** are listed with the pattern that trapped them. You can walk pattern → next guess.
- **Guaranteed** means every answer was played to a depth ≤ n and every later guess was an exhaustive choice. A shortlist strategy that happens to finish within n is reported as a real strategy, and it is not given that stronger label.
- On a long list, sets of up to 8 answers are searched in full when the legal guess list fits in the cap. Hard mode on the full English list picks later guesses from a letter-coverage shortlist, so the tree is marked approximate. Answers over n broke **this** strategy. A different continuation might still fit, and the page does not claim otherwise. Branches cut off by the time limit stay unproved.
- The Analysis guarantee checkbox is unchanged. It still fails closed when it cannot prove a line. Ranking every opener for a hard-mode guarantee at full size stays out of the browser. Tree is the view for one opener you already chose.

The two policies are worst-case depth and fewest expected steps. Both report the average and the maximum for the tree they actually play.

## Tests

Engine and pack checks (Node, no browser):

```bash
node test/engine.test.js
node test/guarantee.test.js
node test/tree.test.js
node test/tree-status.test.js
```

`node test/tree-ui.js` starts its own static server and clicks Build tree in Chrome (same `puppeteer-core` dependency as the smokes below). It covers a click while the pack is still loading, a click after the pack fails, a bad opener, and a worker failure whose sync fallback also throws.

Browser smoke tests expect this site on port 18432 and Chrome plus `puppeteer-core` (`npm install puppeteer-core`, or the older path `/workspace/dst-map/node_modules/puppeteer-core`):

```bash
python3 -m http.server 18432 --directory src
node test.js
node t2.js
```

Screenshots from those scripts go to `/tmp/solver-shots/` unless `SOLVER_SHOT_DIR` is set.
