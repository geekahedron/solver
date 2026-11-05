# Solver

Client-side Wordle-style solver. Enter guesses and color clues; it lists the answers still possible and ranks the next guess the way Wordlebot does (expected remaining, entropy, worst case, and pattern splits).

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
- **Page** — Scenario (remaining lists), Analysis (pattern partitions and scores), or both.

The English presets are that one pack: `src/packs/wordle-en.json`, the ENABLE lists, and Wordle `consistent` / feedback. Custom paste and upload still build a pack in the browser. Dungleon, Purrdle, and Mastermind are not playable here; `src/packs/mastermind-sketch.json` only reserves the shape. Details are in [docs/pack-format.md](docs/pack-format.md).

## Tests

Engine and pack checks (Node, no browser):

```bash
node test/engine.test.js
```

Browser smoke tests expect this site on port 18432 and Chrome plus `puppeteer-core` (`npm install puppeteer-core`, or the older path `/workspace/dst-map/node_modules/puppeteer-core`):

```bash
python3 -m http.server 18432 --directory src
node test.js
node t2.js
```

Screenshots from those scripts go to `/tmp/solver-shots/` unless `SOLVER_SHOT_DIR` is set.
