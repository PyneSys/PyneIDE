# Changelog

All notable changes to the **PyneIDE** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-24

First public preview. This is everything the initial preview ships with.

### Added

#### Getting started

- A seven-step **Get Started** walkthrough — from the Welcome page,
  `Help > Get Started`, or the `PyneIDE: Get Started` command — mapping the whole
  chain: Python environment → PyneSys sign-in → project → market data → run and
  debug. Steps tick themselves off as you complete them, including ones you had
  already done before opening it.
- Empty sections of the **Pyne** view offer a clickable next step —
  "New Script…" and "Download market data…" — instead of standing empty.

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
- **Python-analysis takeover**: initializing a Pyne project routes `.py`
  analysis to the bundled, Pyne-aware pyright setup instead of Pylance — in
  workspace settings only, announced by a notification carrying a "Keep Pylance"
  undo. Never a guess: an existing workspace choice of yours is left alone, and
  "Use PyneIDE for Python Analysis" is there to ask for it later.

#### Pine → Pyne compilation

- **One-click Pine compilation** through the PyneSys cloud compiler, with a
  local content-hash cache, overwrite protection, and a free v4/v5 → v6
  conversion path. Compiling Pine requires a PyneSys account and API key.
- Sign in / sign out with an API key stored in the OS secret store; import of an
  existing key from the `pyne` CLI configuration. The key prompt has a
  **"Create API Key"** button that opens the signup page, and signing out asks
  for confirmation first, since a stored key can never be read back.
- Compile errors are reported in the Problems panel — except while the Pine
  language server is running, which already reports them as you type, so the
  same error is never listed twice. They are cleared as soon as you edit.
- `.pine` files get their own **Run Pine Script** / **Debug Pine Script** labels
  everywhere, and "Convert Pine to v6" is hidden on files that already are v6.

#### Managed Python environment

- Managed, reproducible **Python environment** bootstrapped with `uv`
  (Python + PyneCore), with no dependency on the Microsoft Python extension.
- The first-run prompt states the download size up front (~80 MB), and a stalled
  connection fails with an error instead of hanging on the spinner forever.
- Setup shows **real progress**: a filling bar and a step label that names what
  it is fetching (uv, Python, packages — with a package counter), and it can be
  **cancelled** at any point. What was already downloaded is kept, so starting
  setup again continues from there.
- Network failures are explained in plain language — offline, refused, timed
  out, or an intercepted HTTPS certificate — naming the host that failed and
  the hosts setup must be able to reach, with Retry and Repair on the message.
- **PyneCore plugin manager** (`PyneIDE: Manage Plugins`): browse the plugin
  catalogue, filter to what is installed, read each plugin's own documentation,
  and install or uninstall into the managed environment. A plugin that needs a
  newer PyneCore than the one bundled cannot be installed by accident.

#### Running scripts

- Run your Pyne code or compiled Pine scripts against downloaded OHLCV data,
  streaming into the chart bar by bar.
- **Stop takes the Run button's place** on the running script's tab (and sits at
  the end of the CodeLens row), so stopping a run needs no menu hunting.
  Running a script that is already running restarts it instead of refusing, and
  a stuck run is escalated from a graceful cancel to a kill.
- The **PyneIDE Run** output channel reveals itself once per run at the first log
  line — so `log.info()` output is not buried under other channels — while the
  focus stays in the editor (`pyneide.run.revealOutputOnLog`).

#### Interactive chart

- A streaming, **interactive candlestick chart** (KLineChart) with faithful Pine
  plot rendering (lines, histograms, steplines, areas, `plotcandle`/`plotbar`,
  `bgcolor`, `barcolor`, fills, shapes, `hline`), script-driven drawings
  (`line`/`label`/`box`/`table`), a per-plot layers popup, a legend toggle, a
  measure tool, go-to-date, and fullscreen.
- Strategy support: trade markers, a full-run equity/performance curve, and
  Trades / Stats tables, with CSV export of plot and trade data.
- **Chart style** picker in the toolbar: candles, hollow candles, OHLC bars,
  monochrome, line, or area. The pick is remembered
  (`pyneide.chart.candleStyle`) and applies to every open chart.
- **Price-axis controls** in the bottom-right corner, where TradingView puts
  them: `A` toggles auto-fit, `L` switches to a logarithmic axis and `%` to
  percent change from the first visible bar (`pyneide.chart.priceScale`).
- Switching your VS Code **color theme re-colors the chart live** — grid, axis,
  crosshair, monochrome candles and the hand-painted layers included — without
  waiting for the next run.
- Re-running keeps your place: the visible bar range and zoom survive the
  rebuild, the previous frame stays on screen while the new run fills in, and a
  busy spinner appears only if the run is slow enough to notice.

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
  The browser's download bar mirrors the `pyne` CLI wizard field for field:
  timeframe presets or a custom one, a From that defaults to continuing an
  existing file, To `now` or a date, and a Truncate switch offered only when the
  target file already exists.
- Every downloaded feed has its own actions — **Update (continue)**,
  **Truncate & Re-download…**, **Download Other Timeframe…**, **Preview Chart**
  and **Delete Data…**. Downloads report real percentages in a notification you
  can cancel, instead of an opaque spinner.
- The OHLCV table viewer reads PyneCore's self-describing binary format: it
  builds its columns from the file's own schema (so extra series such as
  bid/ask, open interest or VWAP show up when present), reverses the
  chronological order from the `#`/time header, and refreshes itself when the
  file is re-downloaded underneath it.
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
- Settings are grouped into **General**, **Code Intelligence** and
  **Environment** sections in the Settings UI.
- Licensed under **GPL-3.0-only**, Copyright (C) 2026 PYNESYS LLC — see the
  bundled `COPYRIGHT` and `LICENSE` files.
