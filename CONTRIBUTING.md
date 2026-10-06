# Contributing to PyneIDE

Thanks for your interest. Bug reports, reproducible issues and pull requests are
all welcome.

PyneIDE is the editor side of Pyne: the VS Code extension, the chart, the
debugger and the managed Python environment. The language and runtime semantics
live in [PyneCore](https://github.com/PyneSys/pynecore) — if a Pyne script
*behaves* wrong, that is where the fix belongs.

## Licensing — please read before opening a pull request

PyneIDE is GPL-3.0-only and stays that way. Contributions additionally require a
signed [Contributor License Agreement](CLA.md), which lets PYNESYS LLC reuse
contributed code in non-GPL PyneSys products as well. The CLA explains why, and
signing is a single comment on your first pull request.

If you would rather not sign, open an issue with the description or a patch
instead, and the change can be reimplemented independently.

Never paste in code whose license is incompatible with GPL-3.0-only. In
particular, TradingView Pine Script community scripts are not a usable source,
which is why the bundled snippets were written from scratch.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

```bash
npm install
npm run watch        # esbuild in watch mode
```

Then press F5 in VS Code to launch an Extension Development Host.

On first run the extension bootstraps its own Python environment into the
editor's global storage (uv + a standalone CPython + a venv with PyneCore and
debugpy). That is roughly an 80 MB download and 250 MB on disk, and it is
managed entirely by the extension — do not point it at a system Python.

### Working against a local PyneCore checkout

By default the managed environment installs a pinned PyneCore from PyPI. To run
your own checkout instead, create a separate development venv and install
PyneCore in editable mode, with its `[all]` extra and `debugpy`. Set
`pyneide.venvPath` to that venv's directory, or `pyneide.pythonPath` to its Python
executable. `venvPath` takes precedence when both are set.

PyneIDE only checks a selected external environment; setup, update and repair
commands do not modify it. Refresh the editable installation after changing
PyneCore's package version so its installed metadata reflects the checkout.

## Before you open a pull request

Run at least:

```bash
npm run check         # tsc --noEmit
npm run build
npm run test:grammar
npm run test:report
```

If you touched anything under `src/env/`, the Python bridge, or the PyneCore
pins, also run the environment smoke test, which performs a real, clean install:

```bash
npm run test:env
```

The other `npm run test:*` scripts are focused smoke tests (`test:pinels`,
`test:pyright`, `test:checker`, `test:edge-corpus`, `test:bridge-viz`,
`test:bridge-security`, `test:chart-breakpoints`, `test:library-imports`,
`test:symbol-map`, `test:plugins`). Run the ones covering what you changed.

CI runs the build on Linux and the environment smoke test on Linux, macOS and
Windows. The Windows leg matters: it is where POSIX-only assumptions surface.

## The PyneCore pin is part of the contract

The extension and PyneCore talk over a private, unversioned protocol — compile
output, `--inspect-*` events, CLI flags, syminfo. That is why the managed
environment pins an exact PyneCore version in `src/env/constants.ts` instead of
floating the latest release.

So: **adopting a newer PyneCore API and moving the pin belong in the same
commit.** Local development against an editable checkout never notices the
difference; a clean CI install dies immediately.

`SETUP_DOWNLOAD_MB` in the same file is hand-measured, not computed — if you
bump a pin, re-measure it.

The extension also ships the matching PyneCore documentation under
`resources/pynecore/`. After changing the pin, copy the docs from that release's
tag in a local PyneCore checkout:

```bash
npm run docs:sync -- /path/to/pynecore
```

The sync uses `v<PYNECORE_VERSION>`, preserves the documentation and its license
files verbatim, and records the source commit and file checksums. Builds verify
the snapshot offline and fail if its version or contents no longer match.

Project initialization generates `pine-development`, `pyne-development` and
`pyneide-workflow` skills from `resources/agent-skills/` into `.agents/skills/`,
`.claude/skills/` and `.cursor/skills/`. These are internal agent references;
the Documentation menu keeps its public links. Pine guidance is authored here
and includes a topic index into external documentation; no TradingView text is
bundled. Pyne guidance reads the pinned Markdown snapshot inside the extension.

Each generated skill receives `references/project.json` with the actual workdir,
interpreter, CLI and documentation locations. `.agents/pyneide-skills.json` tracks
the generated file hashes, so reinitialization can refresh unchanged generated
files while preserving user-authored or edited files. Run `npm run test:agent-skills`
after changing the templates or generator.

The project-root `AGENTS.md` routes work to these skills, and `CLAUDE.md` imports
it. Their marked PyneIDE sections are refreshed independently of existing user
instructions; an edited section is preserved. `AGENT_RULES.md` belongs to the
user and is never refreshed from a template. **Edit Agent Rules…** opens it even
while the agent files are hidden. `pyneide.showAgentFiles` is a resource-scoped,
default-off Explorer visibility setting; its changes affect initialized Pyne
projects only and retain unrelated exclusions.

## Code style

Match the surrounding code. The project uses TypeScript with `strict` on, and
comments are sparse and explain *why*, not *what*. If a fix exists because of a
non-obvious platform or API quirk, a one-line comment naming the quirk is worth
more than a paragraph describing the code.

## Naming

Two rules that are not stylistic:

- Never write "Pyne Script" in user-facing text. It is **Pyne code**. `.pine`
  files keep "Pine Script", which is TradingView's actual product name.
- Pine Script is a trademark of TradingView, Inc., and PyneIDE is not affiliated
  with or endorsed by TradingView. Do not write anything that implies otherwise.
