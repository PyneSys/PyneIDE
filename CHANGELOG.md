# Changelog

All notable changes to the **PyneIDE** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-24

First public preview. This is everything the initial preview ships with.

### Added

#### Language support

- Pine Script **v6 syntax highlighting** for `.pine` (and `.psc`) files, with the
  builtin namespaces and keywords kept in sync with the PyneComp compiler.
- Pine doc-comment highlighting (`//@function`, `//@param`, `//@returns`, …) and
  `#region`/`#endregion` folding markers.
- **Pyne** (`@pyne` Python) detection: `.py` files whose module docstring starts
  with `@pyne` are recognized, badged in the Explorer, and stay regular Python so
  Pylance and the rest of your Python tooling keep working.
- Pyne type support: `Series[T]` handling, a bundled type-check pipeline, and
  a strict **Pyne Edge** linter for the Pine-compatible Python subset.
- Pine and Pyne code snippets, and workspace-library import completion,
  go-to-definition, hover, signature help, and call-argument diagnostics.

#### Pine → Pyne compilation

- **One-click Pine compilation** through the PyneSys cloud compiler, with a
  local content-hash cache, overwrite protection, and a free v4/v5 → v6
  conversion path. Compiling Pine requires a PyneSys account and API key.
- Sign in / sign out with an API key stored in the OS secret store; import of an
  existing key from the `pyne` CLI configuration.

#### Running scripts & interactive chart

- Managed, reproducible **Python environment** bootstrapped with `uv`
  (Python + PyneCore), with no dependency on the Microsoft Python extension.
- Run your Pyne code or compiled Pine scripts against downloaded OHLCV data, with a
  streaming, **interactive candlestick chart** (KLineChart): faithful Pine plot
  rendering (lines, histograms, steplines, areas, `plotcandle`/`plotbar`,
  `bgcolor`, `barcolor`, fills, shapes, `hline`), script-driven drawings
  (`line`/`label`/`box`/`table`), a per-plot layers popup, a measure tool,
  go-to-date, and fullscreen.
- Strategy support: trade markers, a full-run equity/performance curve, and
  Trades / Stats tables, with CSV export of plot and trade data.

#### Debugging (Pyne & Pine)

- A Pine-aware **debugger** with a custom `pyne` debug adapter (no Microsoft
  Python extension dependency): a bidirectional Pine ↔ Python sourcemap so you
  debug in Pine terms, demangled variable names, a synthetic **Pyne** scope with
  the current bar's OHLCV/time, and series-history watch expressions
  (e.g. `close[1]`).
- **Bar-level controls** — Next bar, Run to bar — and **chart-bar breakpoints**:
  set a breakpoint on a specific bar/date by choosing it on the chart.

#### Data & workspace

- A dedicated **Pyne** activity-bar view grouping Scripts, Data, and Output.
- New-script wizard (Pine/Pyne × indicator/strategy/library) using the canonical
  TradingView-compatible library layout.
- **Symbol browser** and a data-download wizard over multiple providers, plus a
  read-only OHLCV table viewer and a symbol map for `request.security()` sources.
- On-demand input form editor for a script's inputs, canonicalized through
  PyneCore's own TOML I/O.

#### Help

- **Report a Problem** — from a failed compile or run, or from the status bar
  menu. It gathers versions, environment state and the recent logs, replaces
  every path with a placeholder and strips credential-shaped strings. The
  script itself is only attached when you pick "Send with my code"; choosing
  otherwise also removes the source lines Python quotes inside tracebacks.
  Nothing is ever sent without an explicit confirmation, and the full payload
  can be previewed first.

### Notes

- **No automatic telemetry.** The extension collects and sends no usage data.
- Licensed under **GPL-3.0-only**.
