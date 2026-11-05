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
| `src/core.js` | Feedback patterns and scoring |
| `src/worker.js` | Scoring off the UI thread |
| `src/app.js` | Clues, packs, breakdown |
| `src/packs/englishN-*.txt` | Built-in lists, N = 4..8 |
| `test.js`, `t2.js` | Browser smoke scripts (Puppeteer) |

`test.js` and `t2.js` expect the page on port 18432 and Puppeteer at `/workspace/dst-map/node_modules/puppeteer-core`.
