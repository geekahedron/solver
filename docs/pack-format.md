# Pack format

A solver page loads one **GamePack** and changes behavior with toggles. Packs are JSON. Word lists stay beside the JSON as plain text. An optional script can supply the three validators when the built-in rules are not enough.

The running English game is `src/packs/wordle-en.json` (lengths 4–8). A non-playable Mastermind shape is `src/packs/mastermind-sketch.json`.

## Tokens and words

- **Token** — opaque string. A letter is `"e"`. A card is `"10C"` or `"AS"`. The engine never looks inside a token.
- **Word** — `Token[]` of the pack length.
- **Delimiter** — only for parsing and printing:
  - `none` — one Unicode code point per token. Whitespace is removed. Used by the English packs.
  - `charset` — tokens split on spaces and commas. One entry per line in a list file. Used for cards and other multi-character tokens.
  - `fixed` — split on `delimiterValue` (default `"-"`).

Case folding (`caseInsensitive`) happens before the split, and only for I/O.

## JSON shape

```json
{
  "id": "wordle-en",
  "name": "English Wordle-style",
  "delimiter": "none",
  "delimiterValue": "-",
  "caseInsensitive": true,
  "clueShape": "perSlot",
  "clueAlphabet": [
    { "id": "absent", "value": 0, "label": "B", "symbols": ["b", "r", "x", "w", "0"] },
    { "id": "present", "value": 1, "label": "Y", "symbols": ["y", "p", "o", "1"] },
    { "id": "correct", "value": 2, "label": "G", "symbols": ["g", "c", "2"] }
  ],
  "tokenRenderer": "tiles/letters",
  "clueRenderer": "clues/wordle-gyb",
  "feedback": "wordle",
  "rules": "builtin:wordle",
  "alphabet": "abcdefghijklmnopqrstuvwxyz",
  "pools": { "theoretical": "guessList" },
  "variants": [
    {
      "id": "wordle-en-5",
      "name": "English 5-letter",
      "length": 5,
      "knownSolutions": "english5-answers.txt",
      "guessList": "english5-guesses.txt"
    }
  ]
}
```

`alphabet` is a string of code points when `delimiter` is `none`, or an array of tokens (`["1","2","3"]`) otherwise. An empty alphabet allows any token.

List paths are relative to `src/packs/`. `knownSolutions` is the published answer list. `guessList` is every allowed guess (for English, that file already includes the answers; duplicates are merged).

`pools.theoretical`:

| Value | Meaning |
| --- | --- |
| `guessList` | Theoretical solutions are the guess list (and the known answers) that pass `validSolution`. This is the English pack. |
| `known` | Reserved for packs whose only solutions are the known list. Known rows are still marked theoretical today. |
| `alphabet` | Reserved. The engine does **not** expand alphabet^length yet (Mastermind 6^4 would, a 5-letter Latin alphabet would not). |
| `generated` | The rules script's `generateSolutions()` fills the theoretical pool. Known answers are still loaded from the list file. A known answer that fails `validSolution` stays on the known list and is reported as rule drift; it is not dropped. |

Analysis scoring is the Wordlebot partition. Per-slot marks are packed into an integer, position 0 the least significant digit. The radix is one more than the largest clue-alphabet `value` (3 for the English 0/1/2 marks). `feedback` on the JSON is `wordle` (extra copies go gray), `simple` (any present token goes yellow), or left to a script (see below).

## Validators

```text
validGuess(word) -> boolean
validSolution(word) -> boolean
consistent(guess, clue, secret) -> boolean
consistentAll(history, secret) -> boolean   // every clue, folded by the engine
```

`rules` is either:

- `builtin:wordle` or `builtin:simple` — a word is valid when it matches the length and alphabet and it is in the loaded lists. `consistent` is “the feedback of `guess` against `secret` equals `clue`”.
- `script:rules/wordle.js` — the page fetches that file and evaluates it as a function body with `module` and `exports`. The script must export `validGuess`, `validSolution`, and `consistent`. An optional `feedback(guess, secret, ctx)` may return a clue (`{ digits, pat }` or a pattern integer). `ctx` is the engine (`structural`, `inLists`, `pattern`, `cluePattern`, `pack`).

Set `feedbackKind` to `'custom'` when that `feedback` should replace the built-in scorer. The engine then uses it for remaining-set checks (`consistentAllIndex`, `partition`, `replay`) and for Analysis (one-ply partitions, expected steps, the depth search, and the opener tree). The pattern radix follows the clue alphabet, so a pack can use more than three marks. An optional `feedbackIds(g, go, a, ao, L)` may return the same pattern from symbol-id arrays; Analysis calls that on the hot path when it is present. Omit `feedbackKind`, or set it to `'core'`, to keep Wordle's base-3 `Core.feedback` (the reference script does this). A custom `feedback` must compute the clue itself. Calling `ctx.pattern` from a custom feedback loops.

`generateSolutions()` may return the theoretical word list (strings or token arrays). The engine calls it when `pools.theoretical` is `generated`, then keeps rows that pass `validSolution`.

The script is not given a DOM or a network helper. It still runs in the page’s JavaScript realm; treat it as an authoring escape hatch, not a sandbox against untrusted authors. The shipped English presets use the builtin so they do not need the script.

`src/packs/rules/wordle.js` is the reference script. It matches `builtin:wordle`. `src/packs/rules/dungleon.js` is the custom-feedback example (five marks, generated solutions).

## Guess modes

These are toggles on one pack, not separate games.

| Mode | Suggestion pool |
| --- | --- |
| `any` | Any token list of the right length over the alphabet may be typed and analyzed. Suggestions stay on the loaded lists; the page does not enumerate alphabet^n. |
| `dictionary` | `validGuess` (the loaded lists). The setup menu can still limit that to the answer list. |
| `hard` | `validGuess` and `consistentAll`, treating the candidate as the secret. |
| `answersOnly` | Only rows still inside the active remaining layer. |

**Wordle hard** (reuse greens, and reuse revealed tokens with their counts) is weaker than guess mode `hard`. It stays a separate menu so the old control still means the same thing.

## Solution layers and page modes

History is `{ guess: Word, clue }[]`.

- **known** — `knownSolutions` still consistent with history.
- **theoretical** — the theoretical pool still consistent with history. For English this is the whole dictionary, so it is a superset of the known answers.
- **preferred** — score the known layer while any known answer remains; otherwise score the theoretical layer.

Scenario shows both counts (and both lists). Analysis partitions whichever layer is selected and ranks guesses by expected steps, expected remaining, entropy, worst case, or number of patterns. The all-green bucket counts as zero left. Expected steps is uniform over the remaining answers (no frequency prior) and replays the active guess mode and hard-mode rules on later guesses. Exact through 5 answers (at most 64 guesses tried at one of those nodes). A dictionary larger than 280 is cut to that many probes for the whole search, and the answers still in the set are always added back. Every guess in the pool is valued when at most 40 answers remain and the pool has at most 20000 rows; above that, deepen a beam of 18 expected-remaining, 6 entropy, and 6 worst-case guesses. Larger sets continue with the top 1 one-ply pick from 40 candidates.

**Tree** fixes one starting guess and expands that policy against the active answer list. It walks pattern → next guess, lists per-answer depth, and highlights answers over n. A long hard-mode list uses a letter-coverage shortlist for later guesses and says so. It does not replace the guarantee checkbox, which still fails closed when a line is unproved. The built-in English lists are not the NYT Wordle list Olson’s precomputed trees use.

## Renderers

`tokenRenderer` and `clueRenderer` are ids into the page’s asset libraries (`src/renderers.js`):

| Id | Draws |
| --- | --- |
| `tiles/letters` | Letter tiles |
| `tiles/cards` | Multi-character tokens (cards), without forced capitals |
| `tiles/dungleon` | Letter tiles without forced capitals, used by the Dungleon pack. No glyph art. |
| `clues/wordle-gyb` | G/Y/B, g/y/r, 2/1/0, or emoji tiles. A clue alphabet longer than three marks prints each mark's `label` instead (Dungleon: `rgyYG`). |
| `clues/arrows-lr` | `· ← →` for a future left/right clue |
| `clues/mastermind-pips` | A `2B1W` style summary if marks are 0/1/2 |

Dungleon ships as `src/packs/dungleon.json` (known list `dungleon-solutions.txt`, rules in `rules/dungleon.js`). Purrdle still needs a real pack. It is not shipped.

## Clues

`clueShape` is `perSlot`, `whole`, or `mixed`.

- `perSlot` — one mark per token. The English page parses `bgybb`, `rgyrr`, `21021`, and the green/yellow/black emoji, case-insensitively. A pack with `clueCaseSensitive: true` keeps mark case, so `y` and `Y` are different symbols. Clicking a tile cycles every mark in the clue alphabet.
- `whole` — one clue for the guess (`"2B1W"`). Parsed, not scored, until a pack script defines `consistent` for it. The Mastermind sketch uses this and is not in the preset menu.
- `mixed` — reserved for a clue that has both slot marks and a whole-guess mark.

A per-slot clue in memory looks like:

```json
{
  "shape": "perSlot",
  "slots": ["absent", "absent", "correct", "absent", "correct"],
  "digits": [0, 0, 2, 0, 2],
  "pat": 180
}
```

`pat` is the base-N integer (position 0 is the least significant digit) used by the scorer. N is 3 for Wordle. A mark's `role` is `absent`, `present`, or `correct`. Wordle hard mode locks `correct` slots and requires every `present` or `correct` copy to be reused. `solve: true` is the all-green digit (the guess matches the secret). `paint` is an optional tile class (`b`, `y`, `g`, or a pack class such as `yp` / `gp`).

A manifest may set `guessMode` (`any`, `dictionary`, `hard`, `answersOnly`). Choosing that preset applies the mode; choosing a preset that does not declare one returns to `dictionary` if the previous preset had declared a mode. Reloading the page keeps the saved toggle.
