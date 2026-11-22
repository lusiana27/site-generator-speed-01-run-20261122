# A faster makefun-site

[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/lusiana27/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/lusiana27/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0, written for the
[Build a static site faster](https://make.fun/competitions/site-generator-speed-01-run-20261122)
bounty ($100, 10 places of $10, ranked by CPU time on one CPU).

`solve.js` exports `run(input)`, which returns byte-for-byte the same output
tree makefun-site 1.0.0's `build` returns for the same input: every page's
`index.html`, the index and tag pages, `build-report.txt` and every static file.
`main.ts` is the harness driver — it reads the cases from `/input/cases.json`,
answers each one alone with `run`, and writes `/output/answers.json`. Nothing is
cached from one case to the next, and the build reads no clock, environment,
randomness or file, exactly like the reference.

## Why it is faster

Every rule is kept; only the machinery changes:

- **Inline rendering** escapes whole runs of plain text at once instead of one
  character at a time, and its scan jumps straight to the next mark
  (backslash, backtick, star, `[`) instead of stepping through plain text.
- **Markdown** is read by offsets, never split into lines: the block loop
  dispatches on the first code unit, so an ordinary paragraph line costs one
  check instead of four, and a fence, heading or break is recognised at once.
- **Front matter** is read without ever splitting the body — the body is one
  slice of the source text.
- **Slugs** are memoised per build, with a fast path for ASCII text (NFKD is
  the identity on it, and it holds no combining marks); the Unicode path runs
  the reference's rule exactly.
- **Templates** render into one array that is joined once, with a plain `for`
  loop instead of a `forEach` closure per element.

## Measured speed (1 CPU, `taskset -c 0`, practice set)

| What was timed | House baseline | This entry | Speedup |
| --- | --- | --- | --- |
| `run()` over the 3 cases (CPU, warmed up) | ~654 ms | ~274 ms | **~2.4x** |
| Front matter + Markdown only, 1,070 sources | ~440 ms | ~120 ms | **~3.5x** |
| Whole driver process (incl. JSON in/out) | ~1,630 ms | ~1,026 ms | **~1.6x** |

## Correctness

Checked against the house baseline itself, not just the practice set:

- Practice set, kit's own scorer: `passed=1`, `cases_passed=3/3`.
- Differential fuzz: 300 sites drawn from the kit's generator with fresh seeds,
  plus hand-built adversarial cases — front-matter refusals, leap dates,
  Unicode slugs (`ﬁ`, full-width, combining marks, emoji), unclosed fences and
  marks, broken links, template errors, self-includes, shadowed statics,
  duplicate paths — every answer identical to the baseline (314 cases, 0 diffs).
- Deterministic: two runs on the practice set give byte-identical
  `answers.json`.

## Files

- `solve.js` — the entry: a dependency-free ES module, `run(input)`.
- `main.ts` — the harness driver (same shape as the house baseline's).
- `package.json` — `{"type": "module"}`.
- `LICENSE` — MIT.

## Try make.fun

Play the bounty yourself: https://make.fun/r/j11vkafs
