"""Robustness tests of a strategy run (``--robustness CONFIG``).

The run itself streams as usual. While it does, a ``TradeRecorder`` collects the
closed trades with their initial stops; after the last bar, before the ``end``
event, PyneCore's robustness tests run on them. The coin-flip tests run the
strategy again, so they report their progress and stop at the next backtest when
the IDE cancels.

The results go three ways: the CSV files the ``pyne robustness`` command writes,
``output/<stem>_robustness.json`` for the chart to reload, and one ``robustness``
event. A PyneCore without the analysis package gets a ``robustness`` event with
``supported: false`` and the run carries on without the tests.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Callable, cast

from .control import Control
from .protocol import Emitter

HISTOGRAM_BINS = 40

_UNITS = ("r", "currency", "percent")
_METHODS = ("bootstrap", "shuffle")
_BLOCKS = ("week", "month", "trade")
_PERIODS = ("year", "month", "weekday")
_COINFLIPS = ("direction", "timing", "both", "none")


class RobustnessCancelled(Exception):
    """The IDE cancelled the run while the tests were running."""


def supported() -> bool:
    """True when the installed PyneCore has the robustness tests."""
    try:
        from pynecore.analysis import coinflip  # noqa: F401
        from pynecore.analysis import TradeRecorder, analyze  # noqa: F401
    except ImportError:
        return False
    return True


def parse_config(text: str) -> dict[str, Any]:
    """Read the ``--robustness`` JSON object; unknown or ill-typed keys fall back to
    their defaults when the settings are built."""
    raw = json.loads(text) if text else {}
    if not isinstance(raw, dict):
        raise ValueError("--robustness expects a JSON object")
    return raw


def _choice(value: Any, choices: tuple[str, ...], default: str) -> str:
    return value if isinstance(value, str) and value in choices else default


def _number(value: Any, default: float | None) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return float(value) if math.isfinite(float(value)) else default


def _config(raw: dict[str, Any]) -> tuple[Any, tuple[str, ...], int, bool]:
    """The PyneCore test settings and the coin-flip modes, runs and exactness."""
    from pynecore.analysis import RobustnessConfig
    from pynecore.analysis.costs import DEFAULT_COST_BPS

    unit = raw.get("unit")
    cost = raw.get("costBps")
    costs = tuple(float(c) for c in cost if isinstance(c, (int, float))) \
        if isinstance(cost, list) else DEFAULT_COST_BPS
    periods = raw.get("periods")
    period_list = tuple(p for p in periods if p in _PERIODS) if isinstance(periods, list) \
        else ("year",)
    config = RobustnessConfig(
        unit=unit if unit in _UNITS else None,
        seed=int(_number(raw.get("seed"), 0) or 0),
        draws=max(100, int(_number(raw.get("draws"), 10_000) or 10_000)),
        mc_method=cast(Any, _choice(raw.get("mcMethod"), _METHODS, "bootstrap")),
        block=cast(Any, _choice(raw.get("block"), _BLOCKS, "week")),
        cost_bps=costs or DEFAULT_COST_BPS,
        periods=cast(Any, period_list or ("year",)),
        initial_capital=_number(raw.get("capital"), None),
        risk_fraction=(_number(raw.get("riskPercent"), 1.0) or 1.0) / 100.0,
        ruin_fraction=(_number(raw.get("ruinPercent"), 50.0) or 50.0) / 100.0,
        target_multiple=_number(raw.get("targetMultiple"), None),
        max_leverage=_number(raw.get("maxLeverage"), None) or None,
    )
    mode = _choice(raw.get("coinflip"), _COINFLIPS, "direction")
    modes = ("direction", "timing") if mode == "both" else () if mode == "none" else (mode,)
    runs = max(10, int(_number(raw.get("coinflipRuns"), 200) or 200))
    return config, modes, runs, bool(raw.get("exact"))


def _histogram(totals: list[float], real: float) -> dict[str, Any]:
    """Equal-width bins over the random totals and the real one."""
    values = [t for t in totals if math.isfinite(t)]
    if not values:
        return {"edges": [], "counts": []}
    low = min(min(values), real)
    high = max(max(values), real)
    if high <= low:
        high = low + 1.0
    width = (high - low) / HISTOGRAM_BINS
    counts = [0] * HISTOGRAM_BINS
    for value in values:
        counts[min(HISTOGRAM_BINS - 1, int((value - low) / width))] += 1
    return {"edges": [low + i * width for i in range(HISTOGRAM_BINS + 1)], "counts": counts}


def _jsonable(value: Any) -> Any:
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


class RobustnessSession:
    """Collects the trades of one run and tests them after its last bar."""

    def __init__(self, raw_config: dict[str, Any], position: Any, syminfo: Any,
                 make_runner: Callable[[], Any], output_dir: Path, stem: str):
        from pynecore.analysis import TradeRecorder

        self.recorder = TradeRecorder(position, syminfo)
        self._raw = raw_config
        self._syminfo = syminfo
        self._make_runner = make_runner
        self._output_dir = output_dir
        self._stem = stem

    @property
    def json_path(self) -> Path:
        return self._output_dir / f"{self._stem}_robustness.json"

    def on_bar(self) -> None:
        self.recorder.on_bar()

    def finish(self, emitter: Emitter, control: Control) -> None:
        """Run the tests, write their files and emit the ``robustness`` event."""
        from pynecore.analysis import analyze
        from pynecore.analysis.coinflip import coinflip_test

        trades = self.recorder.trades
        if not trades:
            emitter.emit({"e": "robustness", "supported": True, "report": None,
                          "message": "the run closed no trades: there is nothing to test"})
            return

        config, modes, runs, exact = _config(self._raw)
        emitter.emit({"e": "robustnessProgress", "phase": "tests", "done": 0, "total": 1})
        report = analyze(trades, config)
        emitter.emit({"e": "robustnessProgress", "phase": "tests", "done": 1, "total": 1})

        for mode in modes:
            phase = f"coin flip ({mode})"

            def on_progress(done: int, total: int, phase: str = phase) -> None:
                emitter.emit({"e": "robustnessProgress", "phase": phase,
                              "done": done, "total": total})
                if control.cancelled:
                    raise RobustnessCancelled()

            if control.cancelled:
                raise RobustnessCancelled()
            report.coinflips.append(coinflip_test(
                mode, self._make_runner, self._syminfo, trades, report.unit,
                seed=config.seed, draws=config.draws, exact=exact, runs=runs,
                on_progress=on_progress))

        written = report.write_csv(self._output_dir, self._stem)
        payload = _jsonable(report.to_dict())
        payload["rows"] = _jsonable(report.summary_rows())
        for flip, data in zip(report.coinflips, payload["coinflips"]):
            data["histogram"] = _jsonable(_histogram(flip.totals, flip.real))
        payload["files"] = [str(p) for p in written]
        self.json_path.write_text(json.dumps(payload, allow_nan=False), encoding="utf-8")
        emitter.emit({"e": "robustness", "supported": True, "report": payload,
                      "file": str(self.json_path)})
