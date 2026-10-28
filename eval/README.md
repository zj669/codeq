# codeq eval

Benchmark harness for the find / grep / graph tools. 50 questions against a
pinned FastAPI checkout: find 15, grep 20, graph 15.

## Run

```bash
eval/fetch-fastapi.sh   # one-time: clones fastapi@0.121.1 (shallow) outside the repo
npm run eval            # scores all questions, writes eval/results.json
```

The repo root is configurable: `npm run eval -- /path/to/repo`, or set
`CODEQ_EVAL_ROOT`. `CODEQ_EVAL_REF` changes the pinned tag the fetch script
clones. The eval uses its own `CODEQ_DATA_DIR` (`~/.cache/codeq-eval/data-*`,
one per checkout) so scores always come from this checkout's daemon, not
whichever daemon owns the shared socket; set `CODEQ_DATA_DIR` yourself to
override. `CODEQ_JEV_*` keys are stripped so results are deterministic.

Any repo works, but the ground truths in `questions.json` name FastAPI
paths, so other repos only make sense with a different questions file
(second arg).

Scoring: find/grep = expected file's position in `results[].path` (grep page =
16). Graph = expected file as a top-3 symbol, top-3 caller, or in the flattened
top-5. Warm index only — cold first-call latency is a separate measurement.

## Baseline

50 questions is a regression gate, not a claim about all repos.

v2 baseline (Roman, 2026-10-27, Muse VM, warm index): overall hit@1 60.0%,
hit@3 68.0%, hit@5 68.0%, mean 147ms, p95 280ms.

| tool | hit@1 | hit@3 | hit@5 |
|------|-------|-------|-------|
| find | 93.3% | 100%  | 100%  |
| grep | 25.0% | 25.0% | 25.0% |
| graph| 73.3% | 93.3% | 93.3% |

Known weakness in the baseline: grep for a common token (e.g. `APIRouter`,
`status_code`, `Query`) returned docs first; `fastapi/routing.py` did not
appear in the top 16. Ground truths were re-verified for v2 (v1 scored 52%
overall partly due to Starlette re-export questions with no symbol in-repo).
Compare future runs to v2, not v1.

Current (this checkout, grep context default 1): overall hit@1 72.0%,
hit@3 90.0%, hit@5 96.0%, mean 148ms, p95 295ms. hit@k is unchanged from the
context=0 numbers — context adds neighbor lines, not different locators; the
latency delta is the context fetch.

| tool | hit@1 | hit@3 | hit@5 |
|------|-------|-------|-------|
| find | 93.3% | 100%  | 100%  |
| grep | 55.0% | 80.0% | 95.0% |
| graph| 73.3% | 93.3% | 93.3% |

Remaining known gaps: `graph-10` (`Path` — codegraph indexes no symbol for
`class Path` in `fastapi/params.py`, engine-side gap, not ranking), and in
environments where the FFF watcher genuinely cannot subscribe (inotify
exhaustion), per-query rescans can serve a still-filling index — the daemon
reports `status: degraded` and the `fffWarning` when that happens.
