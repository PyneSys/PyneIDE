# Pine Script v6 documentation index

This file is an authored table of contents and source map. It includes no copied
TradingView documentation or third-party examples.

Community snapshot: `mrojas-mx/pine-script-v6-kb`, commit
`6921c2bc10ae1b16410c103eb37533889d190d47` (2026-08-21).
Paths below were checked against that repository tree. It is an unofficial snapshot;
its guide examples can be reconstructed and should be checked before reuse.

For a repository path `PATH`, the corresponding file is:

```text
https://github.com/mrojas-mx/pine-script-v6-kb/blob/6921c2bc10ae1b16410c103eb37533889d190d47/PATH
```

Use the host's available read-only web tool. For GitHub operations, use an authenticated
`gh` CLI when available and follow the user's tool preferences. A precise raw-text lookup is:

```bash
gh api 'repos/mrojas-mx/pine-script-v6-kb/contents/reference/ta/ema.md?ref=6921c2bc10ae1b16410c103eb37533889d190d47' --jq '.content | @base64d'
```

Change the path for the topic being researched. This reads one page without cloning the repo,
installing an MCP server or copying its documentation into the project.

## Language and execution

| Topic                      | Community file                                       | Official source                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Script structure           | `guide/language/script-structure.md`                 | [Structure](https://www.tradingview.com/pine-script-docs/language/script-structure/)                                                                                                                                      |
| Execution and rollback     | `guide/language/execution-model.md`                  | [Execution](https://www.tradingview.com/pine-script-docs/language/execution-model/)                                                                                                                                       |
| Types and qualifiers       | `guide/language/type-system.md`                      | [Types](https://www.tradingview.com/pine-script-docs/language/type-system/)                                                                                                                                               |
| Variables and persistence  | `guide/language/variable-declarations.md`            | [Variables](https://www.tradingview.com/pine-script-docs/language/variable-declarations/)                                                                                                                                 |
| Operators and history      | `guide/language/operators.md`                        | [Operators](https://www.tradingview.com/pine-script-docs/language/operators/)                                                                                                                                             |
| Conditionals               | `guide/language/conditional-structures.md`           | [Conditionals](https://www.tradingview.com/pine-script-docs/language/conditional-structures/)                                                                                                                             |
| Loops                      | `guide/language/loops.md`                            | [Loops](https://www.tradingview.com/pine-script-docs/language/loops/)                                                                                                                                                     |
| Functions                  | `guide/language/user-defined-functions.md`           | [Functions](https://www.tradingview.com/pine-script-docs/language/user-defined-functions/)                                                                                                                                |
| Methods and objects        | `guide/language/methods.md`, `objects.md`            | [Methods](https://www.tradingview.com/pine-script-docs/language/methods/), [Objects](https://www.tradingview.com/pine-script-docs/language/objects/)                                                                      |
| Arrays, matrices, maps     | `guide/language/arrays.md`, `matrices.md`, `maps.md` | [Arrays](https://www.tradingview.com/pine-script-docs/language/arrays/), [Matrices](https://www.tradingview.com/pine-script-docs/language/matrices/), [Maps](https://www.tradingview.com/pine-script-docs/language/maps/) |

## Indicators, strategies and data

| Topic                      | Community file                                     | Official source                                                                                                                                              |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Indicator API              | `reference/ta/_index.md`                           | [API reference](https://www.tradingview.com/pine-script-reference/v6/)                                                                                       |
| Strategy execution         | `guide/concepts/strategies.md`                     | [Strategies](https://www.tradingview.com/pine-script-docs/concepts/strategies/)                                                                              |
| Strategy API               | `reference/strategy/_index.md`                     | [Strategy entry](https://www.tradingview.com/pine-script-reference/v6/#fun_strategy.entry)                                                                   |
| Symbols and timeframes     | `guide/concepts/other-timeframes-and-data.md`      | [Other contexts](https://www.tradingview.com/pine-script-docs/concepts/other-timeframes-and-data/)                                                           |
| Requests                   | `reference/request/_index.md`                      | [Security](https://www.tradingview.com/pine-script-reference/v6/#fun_request.security)                                                                       |
| Repainting                 | `guide/concepts/repainting.md`                     | [Repainting](https://www.tradingview.com/pine-script-docs/concepts/repainting/)                                                                              |
| Inputs                     | `guide/concepts/inputs.md`                         | [Inputs](https://www.tradingview.com/pine-script-docs/concepts/inputs/)                                                                                      |
| Alerts                     | `guide/concepts/alerts.md`                         | [Alerts](https://www.tradingview.com/pine-script-docs/concepts/alerts/)                                                                                      |
| Bar state                  | `guide/concepts/bar-states.md`                     | [Bar states](https://www.tradingview.com/pine-script-docs/concepts/bar-states/)                                                                              |
| Sessions and timeframes    | `guide/concepts/sessions.md`, `timeframes.md`      | [Sessions](https://www.tradingview.com/pine-script-docs/concepts/sessions/), [Timeframes](https://www.tradingview.com/pine-script-docs/concepts/timeframes/) |
| Visuals                    | `guide/visuals/_index.md`                          | [Visuals](https://www.tradingview.com/pine-script-docs/visuals/overview/)                                                                                    |
| Plots                      | `guide/visuals/plots.md`                           | [Plots](https://www.tradingview.com/pine-script-docs/visuals/plots/)                                                                                         |
| Drawings                   | `guide/visuals/lines-and-boxes.md`                 | [Lines and boxes](https://www.tradingview.com/pine-script-docs/visuals/lines-and-boxes/)                                                                     |
| Libraries                  | `guide/concepts/libraries.md`                      | [Libraries](https://www.tradingview.com/pine-script-docs/concepts/libraries/)                                                                                |

## Errors, limits and migration

| Topic                      | Community file                                     | Official source                                                                                       |
| -------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Errors and warnings        | `errors/_index.md`                                 | [Errors](https://www.tradingview.com/pine-script-docs/errors/overview/)                               |
| Resource limits            | `guide/writing/limitations.md`                     | [Limits](https://www.tradingview.com/pine-script-docs/writing/limitations/)                           |
| Debugging                  | `guide/writing/debugging.md`                       | [Debugging](https://www.tradingview.com/pine-script-docs/writing/debugging/)                          |
| v5 to v6                   | `migration/to-pine-version-6.md`                   | [Migration](https://www.tradingview.com/pine-script-docs/migration-guides/to-pine-version-6/)         |
| Recent language changes    | `migration/release-notes.md`                       | [Release notes](https://www.tradingview.com/pine-script-docs/release-notes/)                          |

In rows with multiple files, abbreviated names share the first file's directory.
For exact symbols, start with the namespace's `_index.md` and read one member page.
The full repository index is `INDEX.md`; avoid loading it when a direct path suffices.

Use PyneCore's bundled compatibility documentation for what the project's pinned runtime
supports; current TradingView documentation can describe features newer than that runtime.
