# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hokireceh/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/hokireceh/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching tiers, and writes every change or none. Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Run it

```sh
node main.ts [options] [PATCH]
```

`mend` applies an edit that an AI model wrote to a tree of text files. See `SPEC.md` for the full contract: invocation, output and exit codes, safe paths, format detection, three-tier line matching, and the four patch formats. Run the practice checks with `node check.ts <practice.json>` from the kit.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jjqnkn84&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
