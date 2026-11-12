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

The built-in English packs (4–8 letters) are **not** the New York Times Wordle lists. A separate preset, **Wordle — NYT WordleBot lists (live)**, fetches a third-party copy at load time. The default pack stays the built-in English 5-letter list.

- Guess lists (`src/packs/englishN-guesses.txt`): every N-letter word in ENABLE (Enhanced North American Benchmark Lexicon), which is in the public domain. The copy used to build them is [dolph/dictionary](https://github.com/dolph/dictionary) `enable1.txt`.
- Answer lists (`src/packs/englishN-answers.txt`): a subset of those ENABLE words (simple `-s` / `-ed` inflections dropped, a few slurs removed), ranked with Peter Norvig’s [`count_1w.txt`](https://norvig.com/ngrams/). Only that frequency ranking was used. The shipped lists contain ENABLE words only.

`build_lists.py` regenerates the packs when ENABLE and `count_1w.txt` are available at the paths it expects. Metric definitions and file notes are in `src/README.txt`.

### WordleBot lists (live)

Game setup can load **Wordle — NYT WordleBot lists (live)**. The page fetches JavaScript files from [WordGamesBot](https://github.com/WordGamesBot/wordgamesbot.github.io) and reads the quoted 5-letter words out of `const name = ["CRANE", …]`. It does not evaluate those files, and it does not commit a copy of the lists. `raw.githubusercontent.com` sends `Access-Control-Allow-Origin: *`, so the browser can read them. The URLs use `HEAD`, which is that repo’s default branch, so a reload picks up their updates (the browser revalidates; GitHub’s own cache is about five minutes). Lists already fetched in this visit are reused when you switch the menus.

| Menu | Default | File | What it is |
| --- | --- | --- | --- |
| Answer list | yes | `WordLists/NYT/Answers_with_ED.js` | WordleBot answers, including regular past-tense -ED verbs |
| Answer list | | `WordLists/NYT/Answers.js` | Same answers with those -ED verbs removed |
| Valid guesses | yes | `WordLists/NYT/Words.js` | Every guess Wordle accepts |
| Valid guesses | | `WordLists/NYT/Guesses.js` | WordleBot’s smaller guess list |

The guess file includes the answers. Counts in the setup card are the lists after that load. The ten English quick picks (SLATE through LATER) are the opener list, and any word that is not a legal guess is dropped, same as the other English lengths.

A fetch that fails, times out (12 seconds), or does not look like a plausible 5-letter list (HTML, a non-array file, or a count outside the pack’s minimum and maximum) leaves the pack you already had on screen. If nothing has loaded yet, the page loads the built-in English 5-letter pack and says why. The WordleBot lists are a public copy of the NYT WordleBot lists, not an official NYT download.

Opening Analysis still uses “Max guesses to score” (default 12,000). `Words.js` is larger than that, so an opening is letter-coverage filtered instead of scoring every guess. With 40 or fewer answers left, expected steps still scores the whole guess list, because it is under the existing 20,000-row cap. Opener bits score only the ten quick picks. Scan openers and Build tree keep the existing per-tree time limit.

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
| `src/list-parse.js` | Parse a remote `const` array of words without evaluating it |
| `src/packs/wordle-en.json` | English 4–8 pack (points at the list files) |
| `src/packs/wordle-nyt.json` | Live WordleBot pack (URLs only; lists are not committed) |
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

The English presets are that one pack: `src/packs/wordle-en.json`, the ENABLE lists, and Wordle `consistent` / feedback. Dungleon is a second built-in pack (`src/packs/dungleon.json`): case-sensitive entity letters, any 5-token guess, a known list of 397 unique previous solutions, and a theoretical pool generated from the dungeon rules. Clues use five marks (`r`, `y`, `Y`, `g`, `G`). Custom paste and upload still build a pack in the browser. Purrdle and Mastermind are not playable here; `src/packs/mastermind-sketch.json` only reserves the shape. Details are in [docs/pack-format.md](docs/pack-format.md).

## Expected steps

**Fewest expected steps to solve** ranks a guess by the average number of further guesses until the secret is named. The secret is uniform over the answers still possible — there is no frequency prior. The guess being scored counts as 1. All-green adds nothing more. Any other reply adds the expected guesses needed to finish that smaller set. Later guesses are chosen from the pool the active guess mode and hard-mode rules would actually allow (dictionary, answers only, strict consistency, or Wordle hard).

On a handmade list small enough to sit under the limits below, that number is the exact tree (sets of 2 and 3 answers have a closed form: 1.5 for a pair when either answer is legal, 5/3 when a guess separates all three and hits, otherwise 2). A solved-in-one secret contributes 1.

Openings are not that tree. Exact through 5 answers (at most 64 guesses tried at one of those nodes). A dictionary larger than 280 is cut to that many probes for the whole search, and the answers still in the set are always added back. Every guess in the pool is valued when at most 40 answers remain and the pool has at most 20000 rows; above that, deepen a beam of 18 expected-remaining, 6 entropy, and 6 worst-case guesses. Larger sets continue with the top 1 one-ply pick from 40 candidates. The page marks those values with ≈. Guesses outside the beam stay blank (–), so a guess that loses on every one-ply metric can be missed. Letter-coverage cuts keep remaining answers first, then the guesses that touch the most common letters. “Max guesses to score” still limits which openers enter the beam.

The built-in lists are not the New York Times Wordle lists, and the prior is uniform, so an English opening will not match Wordlebot’s published average. The live WordleBot pack uses a third-party copy of those lists with the same uniform prior and the same scoring caps, so that opening does not match the published average either.

## Opener solve tree

The **Tree** page fixes one starting guess (SLATE, TARPS, CRANE, or anything you type) and expands a decision tree on the answers still possible. Each feedback pattern shows the policy’s next guess and the words left in that branch. That is the same shape as [Jonathan Olson’s solver](https://jonathanolson.net/wordle-solver/): opener, coloring, next guess. It is not his precomputed NYT Wordle tree.

- The built-in packs are ENABLE subsets, not the New York Times list. SALET and SOARE are not in them. TARPS is on the guess list. CRAMP is on the answer list. The live WordleBot pack is a separate third-party copy; SALET and SOARE are guesses there, not answers.
- Answers are equally likely. There is no frequency prior.
- The tree uses the active guess mode, solution layer, and hard-mode rules on every later guess. Clues already entered shrink the list. **n** starts at 6 minus clues entered.
- Depth is how many guesses this strategy plays, including the opener. Answers over **n** are listed with the pattern that trapped them. You can walk pattern → next guess.
- **Guaranteed** means every answer was played to a depth ≤ n and every later guess was an exhaustive choice. A shortlist strategy that happens to finish within n is reported as a real strategy, and it is not given that stronger label.
- On a long list, sets of up to 8 answers are searched in full when the legal guess list fits in the cap. Hard mode on the full English list picks later guesses from a letter-coverage shortlist, so the tree is marked approximate. Answers over n broke **this** strategy. A different continuation might still fit, and the page does not claim otherwise. Branches cut off by the time limit stay unproved.
- The Analysis guarantee checkbox is unchanged. It still fails closed when it cannot prove a line. Ranking every opener for a hard-mode guarantee at full size stays out of the browser. Tree is the view for one opener you already chose.
- **Scan openers** walks the quick picks in order and stops at the first starter whose played strategy has max depth ≤ n (`summary.strategyFits`). A shortlist line that fits still counts; the scan does not wait for the stronger guaranteed flag. English Wordle and the live WordleBot pack author those picks: SLATE, TARPS, CRANE, CRAMP, TRACE, STARE, CRATE, RAISE, ALERT, LATER, skipping any that are not legal in the loaded lists. A pack with no opener list (Dungleon) ranks the guess list and the answers still possible by expected information and keeps the top 10. That score is the entropy of the feedback patterns the guess would draw, in bits: −∑ p log₂ p, from the same Analysis partition, using the pack’s own marks. The table shows the bits. The page does not expand alphabet^length. When 16 or fewer answers remain, the scan continues with those answers, then other dictionary guesses, then answers already ruled out, up to 40 more. A new scan or Build tree cancels the one in progress. A click while the pack is still loading waits, the same way Build tree does.

The two policies are worst-case depth and fewest expected steps. Both report the average and the maximum for the tree they actually play.

## Tests

Engine and pack checks (Node, no browser):

```bash
node test/engine.test.js
node test/guarantee.test.js
node test/tree.test.js
node test/tree-status.test.js
node test/dungleon.test.js
node test/list-parse.test.js
```

`node test/tree-ui.js` starts its own static server and clicks Build tree in Chrome (same `puppeteer-core` dependency as the smokes below). It covers a click while the pack is still loading, a click after the pack fails, a bad opener, and a worker failure whose sync fallback also throws.

Browser smoke tests expect this site on port 18432 and Chrome plus `puppeteer-core` (`npm install puppeteer-core`, or the older path `/workspace/dst-map/node_modules/puppeteer-core`):

```bash
python3 -m http.server 18432 --directory src
node test.js
node t2.js
node test/scan-ui.js
```

`test/scan-ui.js` checks Scan openers: English quick-pick order, stopping on the first fit, exhaustion, a Wordle-hard probe, cancel, a click that waits for the pack to load, and Dungleon starters ranked by expected information.

Screenshots from those scripts go to `/tmp/solver-shots/` unless `SOLVER_SHOT_DIR` is set.
