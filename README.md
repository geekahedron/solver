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

Wordle opens on **Wordle — NYT WordleBot lists (live)**: a third-party copy of the NYT WordleBot lists, fetched when the page loads. The ENABLE packs (4–8 letters) stay in the menu for other word games. **ENABLE — English 5-letter (reference)** is the bundled alternative, and it is what the page shows if the live fetch fails before any pack is ready.

- Guess lists (`src/packs/englishN-guesses.txt`): every N-letter word in ENABLE (Enhanced North American Benchmark Lexicon), which is in the public domain. The copy used to build them is [dolph/dictionary](https://github.com/dolph/dictionary) `enable1.txt`.
- Answer lists (`src/packs/englishN-answers.txt`): a subset of those ENABLE words (simple `-s` / `-ed` inflections dropped, a few slurs removed), ranked with Peter Norvig’s [`count_1w.txt`](https://norvig.com/ngrams/). Only that frequency ranking was used. The shipped lists contain ENABLE words only.

`build_lists.py` regenerates the packs when ENABLE and `count_1w.txt` are available at the paths it expects. Metric definitions and file notes are in `src/README.txt`.

### WordleBot lists (live)

The page asks this site for the lists (`api/wordlebot.php`). The script keeps one JSON file and reads the quoted words out of WordGamesBot’s `const name = ["CRANE", …]` files. It does not evaluate them, and the lists are not committed and not stored in the browser. A copy younger than 24 hours is served without calling GitHub. An older or missing copy is fetched from the raw URLs (12 second timeout). **Check now** uses that same rule, so it cannot force a GitHub fetch. If the fetch or the parse fails, the last good file is kept and a later try waits 15 minutes. With no file at all, the page shows the ENABLE 5-letter pack.

`python3 -m http.server` does not run PHP, so a local preview fetches WordGamesBot directly. `php -S 127.0.0.1:18432 -t src` uses the cache.

| Menu | Default | File | What it is |
| --- | --- | --- | --- |
| Answer list | yes | `WordLists/NYT/Answers_with_ED.js` | WordleBot answers, including regular past-tense -ED verbs |
| Answer list | | `WordLists/NYT/Answers.js` | Same answers with those -ED verbs removed |
| Valid guesses | yes | `WordLists/NYT/Words.js` | Every guess Wordle accepts |
| Valid guesses | | `WordLists/NYT/Guesses.js` | WordleBot’s smaller guess list |

The guess file includes the answers. Counts in the setup card are the lists after that load. The ten English quick picks (SLATE through LATER) are the opener list, and any word that is not a legal guess is dropped, same as the other English lengths.

A fetch that fails, times out (12 seconds), or does not look like a plausible 5-letter list (HTML, a non-array file, or a count outside the pack’s minimum and maximum) leaves the pack you already had on screen and says why. On a first visit, when nothing is loaded yet, the page shows the ENABLE 5-letter reference pack instead of a blank screen. The WordleBot lists are a public copy of the NYT WordleBot lists, not an official NYT download.

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
| `src/api/wordlebot.php` | Host cache for the WordleBot lists (24 hours, last good copy kept) |
| `src/data/wordlebot/` | Cache file written by that script. Not web-readable |
| `src/packs/wordle-en.json` | ENABLE 4–8 pack (points at the list files) |
| `src/packs/wordle-nyt.json` | Wordle pack (URLs only; lists are not committed) |
| `src/packs/englishN-*.txt` | Built-in lists, N = 4..8 |
| `src/packs/rules/wordle.js` | Optional validator script (the presets use the builtin) |
| `docs/pack-format.md` | Pack JSON shape |

Deploy the files in `src/` to `public_html/tools/solver/`. Do not edit the account’s root `.htaccess`. `data/.htaccess` ships with the solver and denies web access to the cache directory.

PHP writes `data/wordlebot/cache.json` on the first Wordle load. The directory has to be writable by PHP:

```bash
mkdir -p data/wordlebot
chmod 775 data data/wordlebot
```

There is no build step. Wordle works without PHP (the page then reads WordGamesBot directly), and the hosted copy uses the cache so a missing upstream still has the last good lists.

## Game pack

One pack describes a game. The page then toggles how you play it:

- **Guess mode** — `any`, `dictionary`, `hard` (the candidate must fit every clue), or `answersOnly`. Wordle hard (reuse greens and yellows) is a separate, weaker switch.
- **Solution layer** — score **known** answers, the larger **theoretical** list (the dictionary, for English), or **known preferred** (known while any remain, otherwise theoretical). Scenario shows both lists.
- **Page** — Scenario (remaining lists), Analysis (pattern partitions and scores), Tree (one opener’s solve tree), both, or Create (read a pack’s JSON and try an edit in this browser).
- **Guarantee** — on Analysis, keep only guesses that can be proved to finish every remaining answer in at most n further guesses (default 6 minus clues entered), under the same guess mode and hard-mode rules on every later step. Max steps is that multi-ply worst case. The one-ply Worst column is unchanged. When scoring is fewest expected steps, survivors stay ordered by that average.

Wordle’s menu default is the live WordleBot pack (`src/packs/wordle-nyt.json`). The ENABLE presets are `src/packs/wordle-en.json` and the list files beside it: lengths 4–8, with the 5-letter list kept as a reference and as the fallback when the live fetch cannot run. Dungleon (`src/packs/dungleon.json`) keeps case-sensitive entity letters, any 5-token guess, a known list of 397 unique previous solutions (402 in the file; the five anniversary cake dungeons stay out until the Cake option is on), and a theoretical pool generated from the dungeon rules. Clues use five marks (`r`, `y`, `Y`, `g`, `G`). Its tiles and keyboard hotlink pictures from dungleon.com; the letter codes stay the guess, and a broken image falls back to the letter. Dungleon is also the only pack with a Gauntlet toggle: three floors on one page, and a shared-entity filter that narrows floors 2 and 3 (and re-ranks their openers) once earlier solutions are known. Other packs stay a single puzzle. Custom paste and upload still build a pack in the browser. The Create tab shows a built-in pack’s JSON, checks an edit, and can save that JSON as a custom pack in this browser only. A custom pack cannot include new JavaScript, and it cannot use the WordleBot host cache; a plain https word list is fetched here instead. An on-screen keyboard follows the pack alphabet (QWERTY for the English lists, `keyboard.rows` otherwise), types into the focused guess or result box, and can be collapsed. Purrdle and Mastermind are not playable here; `src/packs/mastermind-sketch.json` only reserves the shape. Details are in [docs/pack-format.md](docs/pack-format.md).

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
- **Scan openers** walks the quick picks in order and stops at the first starter whose played strategy has max depth ≤ n (`summary.strategyFits`). A shortlist line that fits still counts; the scan does not wait for the stronger guaranteed flag. English Wordle and the live WordleBot pack author those picks: SLATE, TARPS, CRANE, CRAMP, TRACE, STARE, CRATE, RAISE, ALERT, LATER, skipping any that are not legal in the loaded lists. A pack with no opener list (Dungleon) ranks the guess list and the answers still possible by expected information and keeps the top 10. That score is the entropy of the feedback patterns the guess would draw, in bits: −∑ p log₂ p, from the same Analysis partition, using the pack’s own marks. The table shows the bits. Guess mode Any also scores a bounded sample of other alphabet strings (frequent entities, their other case, and a sample of combinations). It does not expand alphabet^length. Dictionary mode does not add that sample. When 16 or fewer answers remain, the scan continues with those answers, then other dictionary guesses, then answers already ruled out, up to 40 more. A new scan or Build tree cancels the one in progress. A click while the pack is still loading waits, the same way Build tree does.

The two policies are worst-case depth and fewest expected steps. Both report the average and the maximum for the tree they actually play.

## Tests

Engine and pack checks (Node, no browser):

```bash
node test/engine.test.js
node test/guarantee.test.js
node test/tree.test.js
node test/tree-status.test.js
node test/dungleon.test.js
node test/gauntlet.test.js
node test/list-parse.test.js
node test/appearance.test.js
php -l src/api/wordlebot.php
php -l src/api/wordlebot-lib.php
php test/wordlebot-cache.php
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
