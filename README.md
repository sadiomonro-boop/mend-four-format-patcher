# mend-four-format-patcher

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sadiomonro-boop/mend-four-format-patcher/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sadiomonro-boop/mend-four-format-patcher/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line tool that applies AI-written edits in four formats — unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — to a tree of text files. It finds the lines each edit names even when their whitespace or indentation drifted, at the first of three matching tiers, and changes every file or none. Node 22 and its standard library only; no install step, no model calls, fully deterministic.

## Run it

```sh
node main.ts [options] [PATCH]
```

Apply a patch file to the tree in the working directory (`-` or no PATCH reads the patch from standard input). `--format=unified|search-replace|v4a|json|auto` picks the format, `--check` dry-runs without writing, and `--strict` matches lines exactly. To run the 100 public practice checks from the kit:

```sh
node check.ts ../program/generator/practice.json
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
