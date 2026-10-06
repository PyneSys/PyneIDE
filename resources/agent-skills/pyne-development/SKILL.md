---
name: pyne-development
description: Write, debug or review Pyne code, indicators, strategies and libraries using the project's PyneCore runtime. Provides Pyne programming basics and an offline topic index into the IDE's bundled documentation.
---

# Pyne development

Read `references/project.json` first. `pynecoreDocs` is the absolute filesystem directory
of the PyneCore Markdown documentation bundled with this IDE. Use ordinary file reads;
no network or additional documentation server is needed. The snapshot version is
`documentationVersion`; `runtimeVersion` records the environment selected at initialization.
If those differ, check the installed API before using a version-specific feature.

If an IDE update or a project move made the recorded path stale, locate the installed
`pynesys.pyneide` extension through the editor's extension registry or, where available,
`code --locate-extension pynesys.pyneide`. Its docs are under `resources/pynecore/docs`;
read the neighboring `manifest.json` for their version. Do not fetch an online copy as a
substitute for a missing local snapshot without the user's request.

Paths in the contents below are relative to `pynecoreDocs`. The complete file inventory
is in `references/documentation.md`. Read only the pages relevant to the task.

## Pyne basics

- Pyne is Python syntax with bar execution and state transformations. Put `@pyne` in the
  initial module docstring so the runtime recognizes it.
- A runnable indicator or strategy has a decorated `main()` using `@script.indicator`
  or `@script.strategy`. Configure inputs as `input.*` defaults on its parameters. A library has
  `@script.library` decorator.
- Import runtime namespaces from `pynecore.lib` and annotations from `pynecore.types`.
- `Series[T]` stores bar history. The current value participates in ordinary expressions;
  `[1]` selects the previous bar. Explicitly annotate user variables whose history is needed.
- `Persistent[T]` initializes when first reached and preserves state across bars;
  `IBPersistent[T]` also preserves changes across repeated executions of the same bar.
- Plain Python initializers and assignments do not automatically acquire persistent state.
  Keep state owned by a transformed function rather than changing module-level objects from it.
- Function call sites can own separate history and state. Keep stateful calculations on a
  consistent execution schedule; read function isolation before moving them into conditions.
- Use `na(value)` to test missing values and `nz(value, replacement)` deliberately.
- Draw with `plot()` and the drawing namespaces; `main()` can also return named plotted values.
  Preserve inputs in the sibling `.toml` settings file when changing configuration.
- `@pyne edge` restricts the source to a Pine-compatible Python subset; retain that profile
  for compiled Pine code and check the IDE diagnostics before adding Python-only constructs.
- Libraries use `@pyne lib`, explicit `__all__` exports and the project's versioned
  `scripts/lib/<publisher>/<library>/v<N>.py` layout. Read the local library reference for imports.

## Original indicator skeleton

```python
"""@pyne"""
from pynecore.lib import close, color, input, plot, script, ta
from pynecore.types import Series


@script.indicator("Price relative to EMA", overlay=True)
def main(length=input.int(18, "EMA length", minval=1)):
    average: Series[float] = ta.ema(close, length)
    plot(average, "EMA", color=color.teal if close > average else color.orange)
```

## Offline documentation contents

| Task or topic                      | Local document                                     |
| ---------------------------------- | -------------------------------------------------- |
| First script                       | `getting-started/first-script.md`                  |
| Script structure and decorators    | `reference/script-format.md`                       |
| Bar state, Series, persistence     | `overview/core-concepts.md`                        |
| Types and `na`                     | `reference/types.md`                               |
| Inputs                             | `reference/inputs.md`                              |
| Programming patterns and scope     | `scripting.md`                                     |
| Per-call-site history and state    | `advanced/function-isolation.md`                   |
| Technical analysis API             | `reference/lib/ta.md`                              |
| Plots and drawings                 | `reference/lib/plot.md`, `line.md`, `box.md`       |
| Strategy execution and settings    | `strategy.md`                                      |
| Strategy API and trades            | `reference/lib/strategy.md`                        |
| Other symbols and timeframes       | `lib/request-security.md`                          |
| Requested fields                   | `lib/request-data.md`                              |
| Compatibility and differences      | `overview/compatibility.md`, `differences.md`      |
| Local run and data formats         | `cli/run.md`, `data.md`                            |
| Debugging                          | `debugging.md`                                     |
| Live bars and order fills          | `advanced/live-mode.md`, `bar-magnifier.md`        |
| Python host integration            | `programmatic/script-runner.md`                    |

Abbreviated filenames in a row share the first filename's directory.

## Validate the change

Use `pyneBin` and `workdir` from `references/project.json`; do not assume the agent's terminal
has the IDE environment activated. Existing `.pine` files remain the source of truth for
converted scripts. For CLI details, read `cli/run.md` and inspect that CLI's `run --help`.

Run on representative local data, inspect runtime errors and requested outputs, and use
the IDE's chart/debug workflow when the task requires visual or bar-by-bar evidence.
Compare outputs or individual trades where appropriate. Distinguish runtime compatibility
from a current TradingView API description and report the validation actually performed.
