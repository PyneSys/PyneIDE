# PyneIDE

Pine Script and Pyne language support for Visual Studio Code.

> **Disclaimer:** Pine Script is a trademark of TradingView. PyneIDE is not a
> TradingView product and is not affiliated with TradingView.

## Features

- **Pine Script syntax highlighting** for `.pine` (and `.psc`) files — Pine v6
  grammar kept in sync with the [PyneComp](https://pynesys.io) compiler's
  builtin namespaces and keywords.
- **Pyne script detection**: `.py` files whose module docstring starts with
  `@pyne` are badged in the explorer (`Py`, or `PE` for `@pyne edge` scripts).
  Pyne files stay regular Python — all your Python tooling keeps working.

## What is Pyne?

[Pyne](https://pynesys.io) is a Python-based, open runtime for Pine-style
indicator and strategy scripts, powered by
[PyneCore](https://github.com/PyneSys/pynecore). Pine Script sources can be
compiled to Pyne with the PyneSys compiler service.

## Roadmap

This is an early preview. Planned: bundled Python environment, one-click Pine
compilation, running scripts with an interactive chart, and full debugging for
both Pyne and Pine sources.

## License

TBD.
