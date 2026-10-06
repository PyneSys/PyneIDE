---
name: pyneide-workflow
description: Run, debug and inspect Pine or Pyne projects with PyneIDE. Locates project files, the selected Python environment, chart controls, inputs, strategy results and output logs for agents using the IDE or CLI.
---

# PyneIDE project workflow

Read `references/project.json` for the initialized project root, workdir, selected Python
and `pyne` CLI, extension location and bundled PyneCore documentation. The workdir can be
the workspace folder itself or its `workdir/` child. Resolve files from the recorded workdir.
Use the application's available UI tools for rendered-state checks; use the CLI when those
tools are unavailable or the task is a code/runtime check. Instructions do not supply UI tools.

## Project map

| Location within workdir            | Purpose                                            |
| ---------------------------------- | -------------------------------------------------- |
| `scripts/*.pine`                   | Pine source                                        |
| `scripts/*.py`                     | Pyne source or Pine compiler output                |
| `scripts/*.py.map`                 | Generated Pine-to-Pyne debugger source map         |
| `scripts/<name>.toml`              | Inputs and indicator/strategy properties           |
| `scripts/lib/<publisher>/<name>/`  | Versioned Pine/Pyne libraries                      |
| `data/*.ohlcv`                     | Local market data                                  |
| `data/<name>.toml`                 | Symbol, provider and timeframe metadata            |
| `config/`                          | API, plugin and symbol mapping configuration       |
| `output/`                          | Run outputs                                        |

Select the workflow for the target script using the same directory and filename stem:
`name.pine` alone, or `name.pine` together with `name.py`, means the Pine workflow.
`name.py` alone without a matching `name.pine` means the Pyne workflow, where the Python
source can be edited. Pine files with other names do not change that classification.

**When working on Pine, modify only the `.pine` source.** Do not edit, synchronize, delete or
recreate its generated `.py` or `.py.map` companions. Let PyneIDE write them through Compile,
Run or Debug. Manual Python edits change the tracked output hash and cause the next Pine
compilation to warn about manual edits and ask whether to overwrite the file, interrupting
the normal run workflow. Reading generated code is fine; make fixes in Pine. Pyne source
without a matching Pine file remains editable; generated outputs may be changed on an explicit user request.

Use the reported environment instead of a system Python. External environments selected via
`pyneide.venvPath` or `pyneide.pythonPath` are verified by the IDE and remain user-managed.

## IDE controls and evidence

Open the Pyne view from the Activity Bar. Its workspace tree groups scripts, data and outputs.
Invoke the following names through the Command Palette, editor controls or Pyne tree.

| Goal                          | Command or location                                    |
| ----------------------------- | ------------------------------------------------------ |
| Create script or library      | `PyneIDE: New Script…`                                 |
| Select market data            | `PyneIDE: Select Data…`                                |
| Run Pine                      | `PyneIDE: Run Pine Script`                             |
| Run Pyne                      | `PyneIDE: Run Pyne code`                               |
| Debug Pine/Pyne               | `PyneIDE: Debug Pine Script` / `Debug Pyne code`       |
| Open chart                    | `PyneIDE: Open Chart`                                  |
| Change inputs/properties      | `PyneIDE: Edit Inputs…`                                |
| Strategy results              | Chart: Performance, Trades and Stats                   |
| Market data browsing          | `PyneIDE: Open Symbol Browser`                         |
| Data download                 | `PyneIDE: Download Data…`                              |
| Other-symbol/timeframe feeds  | `PyneIDE: Edit Symbol Map`                             |
| Bar breakpoint                | `PyneIDE: Choose Bar on Chart…`                        |
| Step or run to bar            | `PyneIDE: Next Bar` / `Run to Bar…`                    |
| Stop a run                    | `PyneIDE: Stop Run`                                    |
| Runtime errors/logging        | Output panel: `PyneIDE Run`                            |
| Compiler errors/logging       | Output panel: `PyneIDE Compiler`; Problems panel       |
| Setup/environment failures    | `PyneIDE: Show Environment Log`                        |

For debugging, set a breakpoint in the source and start Debug. Inspect locals, Watch values,
the Pyne bar scope and the corresponding chart bar; record which execution paused.
For strategy validation, check settings, trades and performance rather than a chart image alone.

Pine compilation uses the PyneSys service and the IDE's configured credentials; Pyne execution
uses the local runtime. Do not put credentials in prompts, source code or command output.
Reusing the IDE compiler cache avoids recompiling unchanged Pine code.

## CLI route

The IDE's integrated terminal activates the selected environment, but an agent's shell can be
different. Use the `pyneBin` path and explicit `--workdir` recorded in `project.json`:

```text
<pyneBin> --workdir <workdir> run <script> <data>
```

Pass arguments separately through a process tool, or quote paths correctly in the shell.
`<script>` and `<data>` can be names within the workdir; consult the bundled `cli/run.md`
for flags and output behavior. Prefer an existing local data file for a reproducible check.

## Internal documentation contents

All paths below are relative to the `pynecoreDocs` filesystem directory in `project.json`.

| Task                          | Bundled document                                      |
| ----------------------------- | ----------------------------------------------------- |
| Workdir layout                | `overview/project-structure.md`                       |
| CLI flags and configuration   | `cli/basics.md`, `overview/configuration.md`          |
| Run and output options        | `cli/run.md`                                          |
| Data preparation              | `cli/data.md`                                         |
| Inputs and properties         | `reference/inputs.md`, `strategy.md`                  |
| Other timeframe/symbol feeds  | `lib/request-security.md`, `overview/symbol-map.md`   |
| Debugging details             | `debugging.md`                                        |
| Runtime vs TradingView        | `overview/compatibility.md`                           |

The extension's own README is also available locally at `extensionReadme` in `project.json`.
Load its relevant section for UI detail; the user-facing Documentation command retains its
normal online links and is not needed to read these internal agent references.

After a change, report what was compiled, what ran on which data, and what was checked in
the rendered IDE. If no UI tools were used, keep chart or live-extension behavior unverified.
