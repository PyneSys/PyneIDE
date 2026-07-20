"""Wires pynecore's ScriptRunner to the NDJSON protocol.

Mirrors the file-mode path of ``pyne run`` (pynecore/cli/commands/run.py) but
CLI-free: no typer, no rich, no provider mode. Pine compilation is the IDE's
job (F2) — this module only runs ``.py`` Pyne scripts against ``.ohlcv`` data.
"""

from __future__ import annotations

import ast
import math
import sys
import time
from pathlib import Path
from typing import Any

from .control import Control
from .protocol import Emitter, num_or_none, sanitize

# Flush the pending bar batch when it reaches this many rows or this age.
FLUSH_AGE_SECONDS = 0.1

_MISSING = object()


def _scrub_nonfinite(obj: Any) -> Any:
    """Replace non-finite floats with None recursively (the emitter dumps
    with allow_nan=False; NaN is pynecore's na, None is its wire form)."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _scrub_nonfinite(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub_nonfinite(v) for v in obj]
    return obj


class _VizTap:
    """In-process tap of the viz state pynecore >= 6.6 exposes via ``lib``.

    ``active`` is False when the running pynecore predates the viz layer
    (released 6.5.x): every hook degrades to a no-op and the protocol keeps
    its v1 shape. The tap must copy per-bar state inside the run_iter loop —
    ``run_iter`` clears ``_plot_meta_new``/``_viz_dyn`` after each yield.
    pynecore's own VizWriter drains the same pending-meta list, but only when
    a ``viz_path`` is passed to ScriptRunner — the bridge never does, so the
    tap is the sole drainer.
    """

    def __init__(self, lib: Any) -> None:
        self.active = False
        self.journal = False
        self._lib = lib
        self._metas: dict[str, dict[str, Any]] = {}
        self._colors: list[list[Any]] = []
        self._last: dict[str, Any] = {}
        self._shadow: dict[Any, Any] = {}
        self._draw_events: list[dict[str, Any]] = []
        try:
            from pynecore.core import viz
        except ImportError:
            return
        if getattr(lib, "_plot_meta_new", None) is None \
                or getattr(lib, "_viz_dyn", None) is None \
                or not hasattr(viz, "serialize_meta") \
                or not hasattr(viz, "_encode_color_channel"):
            return
        self._serialize_meta = viz.serialize_meta
        self._encode = viz._encode_color_channel
        self.active = True
        # Drawing journal (line/label/box/table/polyline/linefill). The
        # drawing registries — unlike the per-bar plot state — survive the
        # yield, so the tap diffs them itself with a private shadow dict:
        # no viz_journal ctor param, no viz_events callback needed.
        if hasattr(viz, "journal_diff"):
            self._journal_diff = viz.journal_diff
            self.journal = True

    def drain_metas(self) -> None:
        """Copy newly registered plot metas, keyed by id (upsert: a plot
        turning dynamic re-appends the same meta with ``dynamic=True``)."""
        pending = self._lib._plot_meta_new
        if pending:
            for meta in pending:
                self._metas[meta.id] = self._serialize_meta(meta)
            pending.clear()

    def collect_colors(self, time_ms: int) -> None:
        """Record only-on-change dynamic color deltas for the current bar.

        Must run after the bar's row joined the batch so a flush never emits
        a color delta before the bar it refers to.
        """
        delta: dict[str, Any] = {}
        for cid, val in self._lib._viz_dyn.items():
            # Gradient fill channels carry raw floats — scrub like every
            # other path (the emitter dumps with allow_nan=False).
            enc = _scrub_nonfinite(self._encode(val))
            if self._last.get(cid, _MISSING) != enc:
                self._last[cid] = enc
                delta[cid] = enc
        if delta:
            self._colors.append([time_ms, delta])

    def collect_drawings(self, bar_index: int) -> None:
        """Diff the live drawing registries against the previous bar.

        Runs after the bar's row joined the batch (like collect_colors), so
        every event's bar index refers to an already-flushed-or-in-flight
        bar. The ``t: "ev"`` tag is dropped — the protocol event carries the
        list under its own key.
        """
        events = self._journal_diff(self._shadow, bar_index)
        for ev in events:
            ev.pop("t", None)
            self._draw_events.append(_scrub_nonfinite(ev))

    def emit_metas(self, emitter: Emitter) -> None:
        if self._metas:
            emitter.emit({"e": "plotMeta", "metas": list(self._metas.values())})
            self._metas = {}

    def emit_colors(self, emitter: Emitter) -> None:
        if self._colors:
            emitter.emit({"e": "colors", "d": self._colors})
            self._colors = []

    def emit_drawings(self, emitter: Emitter) -> None:
        if self._draw_events:
            emitter.emit({"e": "drawings", "d": self._draw_events})
            self._draw_events = []

_TRADE_FIELDS = (
    ("entry_id", "entryId"),
    ("entry_bar_index", "entryBar"),
    ("entry_time", "entryTime"),
    ("entry_price", "entryPrice"),
    ("entry_comment", "entryComment"),
    ("exit_id", "exitId"),
    ("exit_bar_index", "exitBar"),
    ("exit_time", "exitTime"),
    ("exit_price", "exitPrice"),
    ("exit_comment", "exitComment"),
    ("size", "size"),
    ("commission", "commission"),
    ("profit", "profit"),
    ("profit_percent", "profitPct"),
    ("cum_profit", "cumProfit"),
    ("cum_profit_percent", "cumProfitPct"),
)


def _serialize_trade(trade: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for attr, key in _TRADE_FIELDS:
        out[key] = sanitize(getattr(trade, attr, None))
    return out


def _serialize_syminfo(syminfo: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for slot in getattr(type(syminfo), "__slots__", ()):
        value = getattr(syminfo, slot, None)
        if isinstance(value, (str, bool, int, float)):
            out[slot] = sanitize(value)
    return out


def _main_location(runner: Any) -> tuple[str, int] | None:
    """Source file + line of the first meaningful statement in the script's
    ``main`` — the anchor for the debugger's hidden "bar stop" breakpoint (stop
    at the top of every bar, on real code, not the ``def``/decorator line).

    The AST's first meaningful statement fixes the floor (a Persistent/Series
    init carries no bytecode of its own, so its line never binds); the first
    ``co_lines`` entry at or past that floor is the real executable line the
    breakpoint lands on. A leading docstring and any leading nested helper
    ``def``/``class`` statements are skipped: a bar-stop on a nested ``def``
    line would surface the helper's definition (and the transform-injected slot
    setup interleaved between the defs, attributed to the ``def main`` line)
    instead of the first per-bar computation."""
    try:
        code = runner.script_module.main.__code__
        filename = code.co_filename
        tree = ast.parse(Path(filename).read_text(encoding="utf-8"), filename)
        fn = next(
            (n for n in tree.body
             if isinstance(n, ast.FunctionDef) and n.name == "main"),
            None,
        )
        if fn is None or not fn.body:
            return None
        body = fn.body
        idx = 0
        first = body[0]
        if (isinstance(first, ast.Expr)
                and isinstance(getattr(first, "value", None), ast.Constant)
                and isinstance(first.value.value, str)):
            idx = 1  # skip a leading docstring
        while (idx < len(body)
               and isinstance(body[idx], (ast.FunctionDef,
                                          ast.AsyncFunctionDef, ast.ClassDef))):
            idx += 1  # skip leading nested helper defs
        if idx >= len(body):
            return None
        floor = body[idx].lineno
        exec_lines = sorted({
            ln for (_s, _e, ln) in code.co_lines()
            if ln is not None and ln >= floor
        })
        if not exec_lines:
            return None
        return filename, exec_lines[0]
    except Exception:
        return None


def _script_type_name(script: Any) -> str:
    from pynecore.types import script_type

    st = getattr(script, "script_type", None)
    if st == script_type.strategy:
        return "strategy"
    if st == script_type.indicator:
        return "indicator"
    return "library"


def _resolve_script(workdir: Path, script_arg: str) -> Path:
    script = Path(script_arg)
    if len(script.parts) == 1:
        script = workdir / "scripts" / script
    if script.suffix == "":
        script = script.with_suffix(".py")
    if script.suffix != ".py":
        raise FileNotFoundError(
            f"Only .py Pyne scripts can run through the bridge, got: {script.name} "
            f"(compile .pine to .py first)")
    if not script.exists():
        raise FileNotFoundError(f"Script file not found: {script}")
    return script


def _resolve_data(workdir: Path, data_arg: str) -> Path:
    data = Path(data_arg)
    if len(data.parts) == 1:
        data = workdir / "data" / data
    # A dot inside the name may belong to the symbol (BTCUSDT.P), append by
    # name instead of with_suffix.
    if not data.name.endswith(".ohlcv"):
        data = data.with_name(data.name + ".ohlcv")
    if not data.exists():
        raise FileNotFoundError(
            f"OHLCV data file not found: {data} "
            f"(convert other formats with: pyne data convert-from)")
    return data


def run(args: Any, emitter: Emitter, control: Control) -> int:
    """Execute the script run; returns the process exit code."""
    from pynecore.core.aggregator import validate_aggregation
    from pynecore.core.ohlcv_file import OHLCVReader
    from pynecore.core.script_runner import ScriptRunner
    from pynecore.core.syminfo import SymInfo
    from pynecore.lib.timeframe import in_seconds

    workdir = Path(args.workdir).resolve()
    script = _resolve_script(workdir, args.script)
    data_path = _resolve_data(workdir, args.data)

    syminfo = SymInfo.load_toml(data_path.with_suffix(".toml"))

    output_dir = workdir / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    plot_path = output_dir / f"{script.stem}.csv"
    strat_path = output_dir / f"{script.stem}_strat.csv"
    trade_path = output_dir / f"{script.stem}_trade.csv"

    # --security KEY=VALUE mappings (backtest file mode only)
    security_data: dict[str, str] | None = None
    if args.security:
        security_data = {}
        for item in args.security:
            key, _, value = item.partition("=")
            if not key or not value:
                raise ValueError(f"Invalid --security mapping: {item!r}")
            sec_path = Path(value)
            if len(sec_path.parts) == 1:
                sec_path = workdir / "data" / sec_path
            if sec_path.name.endswith(".ohlcv"):
                sec_path = sec_path.with_name(sec_path.name[: -len(".ohlcv")])
            if not sec_path.with_name(sec_path.name + ".ohlcv").exists():
                raise FileNotFoundError(
                    f"Security data not found: {sec_path.name}.ohlcv")
            security_data[key] = str(sec_path)

    # Chart timeframe override / bar magnifier (mirrors pyne run --timeframe)
    magnifier_mode = False
    magnifier_source_tf: str | None = None
    if args.timeframe:
        chart_tf = args.timeframe.upper()
        in_seconds(chart_tf)  # raises on invalid timeframe
        data_tf = syminfo.period
        if chart_tf != data_tf:
            validate_aggregation(data_tf, chart_tf)
            syminfo.period = chart_tf
            magnifier_mode = True
            magnifier_source_tf = data_tf

    # Library scripts' imports resolve against workdir/scripts/lib, like the CLI.
    lib_dir = workdir / "scripts" / "lib"
    if lib_dir.is_dir():
        sys.path.insert(0, str(lib_dir))

    with OHLCVReader(data_path) as reader:
        time_from_ts = int(args.time_from) if args.time_from is not None \
            else int(reader.start_datetime.timestamp())
        time_to_ts = int(args.time_to) if args.time_to is not None \
            else int(reader.end_datetime.timestamp())

        size = reader.get_size(time_from_ts, time_to_ts)

        # Pine anchors last_bar_time to the window's final REAL bar — scan back
        # over the writer's gap-fill tail (volume == -1 records).
        last_bar_time = None
        start_pos, end_pos = reader.get_positions(time_from_ts, time_to_ts)
        for pos in range(end_pos - 1, start_pos - 1, -1):
            tail_bar = reader.read(pos)
            if not (tail_bar.volume < 0):
                last_bar_time = int(tail_bar.timestamp * 1000)
                break

        magnifier_iter = None
        if magnifier_mode:
            magnifier_iter = reader.read_from(time_from_ts, time_to_ts)
            ohlcv_iter = iter(())
        else:
            ohlcv_iter = reader.read_from(time_from_ts, time_to_ts)

        runner = ScriptRunner(
            script, ohlcv_iter, syminfo,
            last_bar_index=size - 1,
            last_bar_time=last_bar_time,
            plot_path=plot_path, strat_path=strat_path, trade_path=trade_path,
            security_data=security_data,
            magnifier_iter=magnifier_iter,
            magnifier_source_tf=magnifier_source_tf,
            chart_data_path=data_path,
        )

        is_strategy = _script_type_name(runner.script) == "strategy"
        emitter.emit({
            "e": "start",
            "script": str(script),
            "scriptType": _script_type_name(runner.script),
            "overlay": bool(getattr(runner.script, "overlay", False)),
            "syminfo": _serialize_syminfo(syminfo),
            "data": str(data_path),
            "range": {"from": time_from_ts, "to": time_to_ts, "bars": size},
            "outputs": {
                "plot": str(plot_path),
                "strat": str(strat_path) if is_strategy else None,
                "trades": str(trade_path) if is_strategy else None,
            },
        })

        # Debug only: publish main's first executable line so the DAP proxy can
        # arm its hidden "bar stop" breakpoint there (Next bar / Run to bar land
        # on the top of every bar without depending on the user's breakpoints).
        if args.debugpy_port is not None:
            main_loc = _main_location(runner)
            if main_loc is not None:
                emitter.emit({"e": "debugMain", "file": main_loc[0], "line": main_loc[1]})

        return _stream_run(runner, emitter, control,
                           total_bars=size,
                           is_strategy=is_strategy,
                           batch_size=args.batch_size)


def run_data_only(args: Any, emitter: Emitter, control: Control) -> int:
    """Stream the raw .ohlcv candles for a chart preview — no ScriptRunner, no
    plots. Lets a chart open on its bound data before any run, so the run only
    overlays the plots later. Emits a `start` (with ``dataOnly: True``) + `bars`
    + `end`; honours cancel so closing the chart / starting a real run stops it.
    """
    from pynecore.core.ohlcv_file import OHLCVReader
    from pynecore.core.syminfo import SymInfo

    workdir = Path(args.workdir).resolve()
    data_path = _resolve_data(workdir, args.data)
    syminfo = SymInfo.load_toml(data_path.with_suffix(".toml"))
    mintick = getattr(syminfo, "mintick", None)

    with OHLCVReader(data_path) as reader:
        time_from_ts = int(args.time_from) if args.time_from is not None \
            else int(reader.start_datetime.timestamp())
        time_to_ts = int(args.time_to) if args.time_to is not None \
            else int(reader.end_datetime.timestamp())
        size = reader.get_size(time_from_ts, time_to_ts)

        emitter.emit({
            "e": "start",
            "script": "",
            "scriptType": "indicator",
            "overlay": True,
            "dataOnly": True,
            "syminfo": _serialize_syminfo(syminfo),
            "data": str(data_path),
            "range": {"from": time_from_ts, "to": time_to_ts, "bars": size},
            "outputs": {"plot": "", "strat": None, "trades": None},
        })

        # Raw .ohlcv floats carry float32 storage dust; snap to the symbol's
        # mintick so the preview matches the price grid a run would render.
        def rt(value: float) -> float:
            if mintick and mintick > 0:
                return round(round(value / mintick) * mintick, 10)
            return value

        batch: list[list[Any]] = []
        bars_done = 0
        last_flush = time.monotonic()
        cancelled = False

        def flush() -> None:
            nonlocal batch, last_flush
            if batch:
                emitter.emit({"e": "bars", "d": batch})
                batch = []
            emitter.emit({"e": "progress", "done": bars_done, "total": size})
            last_flush = time.monotonic()

        for candle in reader.read_from(time_from_ts, time_to_ts):
            if control.idle:
                flush()
            if not control.gate():
                cancelled = True
                break
            bars_done += 1
            batch.append([
                int(candle.timestamp) * 1000,
                num_or_none(rt(candle.open)), num_or_none(rt(candle.high)),
                num_or_none(rt(candle.low)), num_or_none(rt(candle.close)),
                num_or_none(candle.volume), None,
            ])
            if len(batch) >= args.batch_size or \
                    time.monotonic() - last_flush > FLUSH_AGE_SECONDS:
                flush()

        flush()
        emitter.emit({"e": "end", "bars": bars_done, "cancelled": cancelled})
        return 0


def _stream_run(runner: Any, emitter: Emitter, control: Control, *,
                total_bars: int, is_strategy: bool, batch_size: int) -> int:
    from pynecore import lib

    plot_keys: list[str] = []
    plot_index: dict[str, int] = {}
    batch: list[list[Any]] = []
    trade_batch: list[dict[str, Any]] = []
    bars_done = 0
    last_flush = time.monotonic()
    cancelled = False
    viz_tap = _VizTap(lib)

    def flush() -> None:
        # Order matters: metas before the bars that reference them, color
        # deltas and drawing events after the bars their timestamps / bar
        # indices join against.
        nonlocal batch, trade_batch, last_flush
        viz_tap.emit_metas(emitter)
        if batch:
            emitter.emit({"e": "bars", "d": batch})
            batch = []
        viz_tap.emit_colors(emitter)
        viz_tap.emit_drawings(emitter)
        if trade_batch:
            emitter.emit({"e": "trades", "d": trade_batch})
            trade_batch = []
        emitter.emit({"e": "progress", "done": bars_done, "total": total_bars})
        last_flush = time.monotonic()

    gen = runner.run_iter()
    try:
        for item in gen:
            if control.idle:
                # Entering pause (or cancel): push the pending batch out so
                # the UI shows every processed bar while the run is halted.
                flush()
            if not control.gate():
                cancelled = True
                break

            candle = item[0]
            plot_data = item[1]
            bars_done += 1
            # Race-free run-to-bar: self-pause on the feed thread once the target
            # is reached (armed by the debug proxy via control.request_runto).
            control.note_bar(bars_done)

            if viz_tap.active:
                viz_tap.drain_metas()

            # lib.* holds the mintick-rounded values of the current bar
            # (raw .ohlcv floats carry float32 storage dust).
            time_ms = int(candle.timestamp) * 1000
            row: list[Any] = [
                time_ms,
                num_or_none(lib.open), num_or_none(lib.high),
                num_or_none(lib.low), num_or_none(lib.close),
                num_or_none(lib.volume),
            ]

            if plot_data:
                new_keys = [k for k in plot_data if k not in plot_index]
                if new_keys:
                    # Rows already in the batch align to the shorter key list
                    # (missing trailing columns read as null) — flush them
                    # before announcing the grown layout.
                    flush()
                    for k in new_keys:
                        plot_index[k] = len(plot_keys)
                        plot_keys.append(k)
                    emitter.emit({"e": "plotKeys", "keys": plot_keys})
                plots: list[Any] = [None] * len(plot_keys)
                for k, v in plot_data.items():
                    plots[plot_index[k]] = num_or_none(v)
                row.append(plots)
            else:
                row.append(None)

            if is_strategy:
                position = runner.script.position
                equity = float(position.equity) if position and position.equity \
                    else runner.script.initial_capital
                row.append(num_or_none(equity))
                if len(item) > 2 and item[2]:
                    for trade in item[2]:
                        trade_batch.append(_serialize_trade(trade))

            batch.append(row)
            if viz_tap.active:
                viz_tap.collect_colors(time_ms)
            if viz_tap.journal:
                viz_tap.collect_drawings(bars_done - 1)
            if len(batch) >= batch_size or \
                    time.monotonic() - last_flush > FLUSH_AGE_SECONDS:
                flush()
    finally:
        # Runs ScriptRunner.run_iter's finally: writes strategy stats CSV,
        # exports still-open trades, closes writers, tears down security
        # subprocesses.
        gen.close()

    flush()

    if is_strategy:
        position = runner.script.position
        if position is not None:
            open_trades = [_serialize_trade(t) for t in position.open_trades]
            if open_trades:
                emitter.emit({"e": "openTrades", "d": open_trades})
            try:
                from pynecore.core.strategy_stats import calculate_strategy_statistics
                stats = calculate_strategy_statistics(
                    position, runner.script.initial_capital,
                    runner.equity_curve if runner.equity_curve else None,
                    runner.first_price, runner.last_price,
                )
                emitter.emit({
                    "e": "stats",
                    "d": {k: sanitize(v) for k, v in stats.to_dict().items()},
                })
            except Exception as exc:  # stats are best-effort, the run itself succeeded
                emitter.emit({"e": "log", "level": "warning",
                              "message": f"strategy statistics failed: {exc}"})

    emitter.emit({"e": "end", "bars": bars_done, "cancelled": cancelled})
    return 0
