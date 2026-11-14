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
  "openers": ["slate", "tarps", "crane"],
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

### Remote lists

A manifest may set `remote` instead of shipping list files. The page fetches each chosen URL at load time and parses a JavaScript const array as data (`src/list-parse.js`). It extracts quoted words of the pack length. It does not evaluate the file. `timeoutMs` aborts a slow response. Each answer or guess entry has `id`, `label`, `file`, `url`, `minCount`, and `maxCount`. `default: true` is the choice when the menu has no saved id. A count outside that range, an HTML body, or a file that is not a const array of words is a failed load.

`src/packs/wordle-nyt.json` is that pack, and it is the Wordle preset the page loads first. Default answers are WordGamesBot’s `Answers_with_ED.js`. Default guesses are `Words.js`. The setup menu can switch to `Answers.js` (regular -ED verbs removed) and `Guesses.js` (the WordleBot guess subset). The same ten English openers apply, then any word that is not a legal guess is dropped. The browser asks `api/wordlebot.php`, which keeps `data/wordlebot/cache.json` for 24 hours and keeps the last good copy if a later fetch fails. **Check now** does not override the 24-hour wait. A preview with no PHP endpoint reads the raw URLs itself. ENABLE (`src/packs/wordle-en.json`, lengths 4–8) stays in the menu for other word games. The 5-letter ENABLE list is the reference alternative. If the fetch fails and a pack is already on screen, that pack stays. If nothing has loaded, the page loads ENABLE 5-letter and says so.

`Words.js` is larger than the page’s “Max guesses to score” default (12,000), so opening Analysis letter-coverage filters it. The ten authored openers are the only words scored for the Bits column. Scan and Build tree keep their existing time limit. With at most 40 answers left, expected steps still scores a guess list of up to 20,000 rows.

`openers` is an optional list of starter guesses. It may sit on the manifest or on one variant. A variant array replaces the manifest list. Omitting it inherits the manifest list. `[]` means that variant authors none.

The Tree quick picks and Scan openers use that list, in that order, after dropping any word that is not a legal guess in the loaded lists. Case follows the pack. English folds case. Dungleon keeps it.

English Wordle authors `slate`, `tarps`, `crane`, `cramp`, `trace`, `stare`, `crate`, `raise`, `alert`, `later`. Other lengths inherit those words and then drop every one that is not in the loaded lists, so a 4-letter game does not invent a different top ten.

When `openers` is missing or empty, the page ranks a bounded candidate set by expected information and keeps the top 10. The information of a guess is the entropy of the feedback patterns it produces on the answers still being solved:

```text
I(g) = −∑ (nᵢ / N) log₂(nᵢ / N)
```

`nᵢ` is the size of one feedback bucket and `N` is the number of answers still possible. The buckets are Analysis `scorePool` (`score.ent`) with the pack’s own feedback, so Dungleon’s five marks stay five marks. The known layer is used when that is the layer being solved. Otherwise the active remaining set is used.

Candidates, kept from the front when the score is capped, are the pack’s guess list, any authored openers already in the universe, then the answers still possible. The page does not expand alphabet^length. Dungleon allows any 5-token guess, and 20^5 is not a candidate set. With no separate guess file the known solutions are the candidates. A product of candidates × answers above 1,500,000 keeps a prefix of that list so the page does not hang.

Scan openers shows this entropy in a Bits column. When 16 or fewer answers remain it still continues with those answers, then other listed guesses, up to 40 more, after the opener list.

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

A pack loaded from the Create tab cannot supply new JavaScript. `script:` is accepted only for `rules/wordle.js` and `rules/dungleon.js`, the files that ship with the page. Anything else is rejected, and the JSON itself is never evaluated.

The WordleBot `remote` block (a host cache of JavaScript const arrays) is also rejected there. A custom pack may instead put an `http` or `https` URL of a plain text list, one word per line, in `knownSolutions` or `guessList`. The browser fetches it and keeps the words in local storage. An array of words, or a file name under `src/packs/`, works too.

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

## Gauntlet

`gauntlet` is optional and pack-level. Only a pack that sets it shows a Normal / Gauntlet toggle. Other packs, Tree, Analysis, Create, and the WordleBot cache are unchanged. It is not a multi-round mode for every game. A variant cannot turn it on.

```json
"gauntlet": { "floors": 3 }
```

`true` means three floors. `floors` is an integer from 2 to 6. Dungleon sets three. The page stacks every floor on one screen. Each floor has its own guesses, clue marks, candidate lists, and suggested openers. The state is saved with the rest of the page state in this browser.

The rule is that one entity (one token, in any slot) appears in every floor’s solution.

- Floor 1 is filtered only by its own clues.
- A floor’s solution is the text in its solution box when that text is a full word, otherwise the latest all-correct guess on that floor, otherwise the single answer left on the active solution layer (known, theoretical, or known preferred). A unique answer on the other layer does not count until you type it or switch layer.
- Once floor 1 has a solution, floor 2 keeps candidates whose tokens intersect that solution. Both the known list and the theoretical list are filtered.
- Floor 3, and any later floor, keeps candidates that intersect the entities shared by every earlier solved floor. With three floors that is the entities present in both floor 1 and floor 2.
- Before every earlier floor is solved, and only after floor 1 is known, a later floor uses a bound instead of the exact intersection. An unsolved earlier floor contributes the entities that still appear in at least one of its remaining candidates on that same layer, after that floor’s clues and after the shared-entity filter already applied to it. The allowed set is the running intersection. A candidate is removed only when it cannot meet the rule for any combination that is still possible. When the missing floor is solved, the set shrinks to the exact shared entities. For the usual three-floor game, before floor 2 is solved, floor 3’s allowed set is floor 1’s entities ∩ (entities still present on floor 2).
- If floor 1 has no solution yet, later floors are not filtered, even if a later solution was typed.
- Clearing or editing a solution recomputes every floor below it. Earlier floors are not filtered by later ones.
- An empty shared set means no candidate can satisfy the rule, so that layer’s list is empty.

Each floor ranks openers against its filtered active-layer answers with the same expected-information score Scan openers uses (top 10). An authored opener list, if the pack has one, stays in that order and the bits are rescored on the floor’s answers. Dungleon has no authored list, so floors 2 and 3 get a new top 10 once their candidate pools narrow. The page does not expand alphabet^length, and the same candidate cap applies.

## Renderers

`tokenRenderer` and `clueRenderer` are ids into the page’s asset libraries (`src/renderers.js`):

| Id | Draws |
| --- | --- |
| `tiles/letters` | Letter tiles |
| `tiles/cards` | Multi-character tokens (cards), without forced capitals |
| `tiles/dungleon` | Letter tiles without forced capitals, used by the Dungleon pack. Pictures, when the pack has `appearance`, are drawn inside that tile. |
| `clues/wordle-gyb` | G/Y/B, g/y/r, 2/1/0, or emoji tiles. A clue alphabet longer than three marks prints each mark's `label` instead (Dungleon: `rgyYG`). |
| `clues/arrows-lr` | `· ← →` for a future left/right clue |
| `clues/mastermind-pips` | A `2B1W` style summary if marks are 0/1/2 |

Dungleon ships as `src/packs/dungleon.json`. Its known list is `dungleon-prevsolutions.txt` (397 unique official dungeons from the previous-solutions history, plus five anniversary cake dungeons that the Cake option leaves out until it is turned on, not the longer generated set). Rules are in `rules/dungleon.js`. It is the only pack that sets `gauntlet` (three floors; see above). Purrdle still needs a real pack. It is not shipped.

## Appearance

`appearance` is optional. Packs that omit it draw each token as its letter. `images` is an accepted alias; `appearance` wins if both are set.

```json
"appearance": {
  "sheet": {
    "url": "https://example.com/sprites.png",
    "cellWidth": 32,
    "cellHeight": 32,
    "columns": 8
  },
  "entities": {
    "A": {
      "label": "Alpha",
      "title": "Alpha",
      "image": "https://example.com/a.png",
      "sprite": { "index": 0 }
    },
    "B": {
      "label": "Beta",
      "image": "https://example.com/b.png",
      "sprite": { "x": 1, "y": 0 }
    }
  }
}
```

`sheet` is the sprite sheet. `url` is `http`, `https`, or a relative path such as `packs/assets/sheet.png`. `cellWidth` and `cellHeight` are the cell size in pixels. `columns` and optional `rows` are the grid. `offsetX` and `offsetY` skip a margin before the first cell. `gapX` and `gapY` are the pixels between cells. `sprite.index` counts from the top left, row by row. `sprite.col` and `sprite.row` (or `x` and `y`) are the cell, not a pixel offset.

`appearance.keyboard.source` and `appearance.tiles.source` are `auto`, `image`, or `sprite`. `auto` tries the token's own image, then its sprite cell, then the letter. `image` and `sprite` use only that source, then the letter. A picture that fails to load shows the letter.

`image` is a larger picture for clue tiles and the guess preview. `label` is the accessible name and, when `title` is omitted, the tooltip. `title` is the tooltip when you want different wording.

Entity keys are the alphabet tokens and are case-sensitive, so `S` and `s` are different pictures. The guess stored by the solver is still the letter code. If a picture fails to load, the tile shows that letter. `data:` and `javascript:` URLs are dropped.

Dungleon sets this field and hotlinks `dungleon.com`. The two-letter file names and the sprite order come from that site's `client.js` (`function V`: `ar`, `ba`, `ch`, `co`, `dr`, `fr`, `go`, `ki`, `ma`, `ne`, `or`, `sk`, `sp`, `th`, `tr`, `ty`, `vi`, `wa`, `wi`, `zo`, `ca`). The pack's own letters are the codes in `rules/dungleon.js` (warrior `W`, spider `s`, goblin `o`, wizard `w`, thief `t`, coin `c`, relic `R`, and the rest). Cake (`ca`, index 20) is not in the pack alphabet.

## Keyboard

`keyboard.rows` is an optional array of rows. Each key is the token to insert, exactly, including case.

```json
"keyboard": { "rows": [["W", "A", "M"], ["B", "S", "s"]] }
```

A case-insensitive alphabet of single `a`–`z` letters, with no `keyboard` field, uses QWERTY. Any other alphabet is wrapped in pack order. The page adds Backspace and Enter. The on-screen keyboard types into the focused guess or result box. The physical keyboard still works. The row can be hidden; that choice is remembered in this browser. It starts open on a narrow screen, and for a case-sensitive pack or a pack with `appearance`. A desktop word-game alphabet starts collapsed.

Keys pick up the best mark already entered for that token (correct, then present, then absent, with a plus mark ahead of the plain one). That uses the clue alphabet's `role` and `paint`. It does not re-run a rules script.

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
