"""Live chart runs: ``--live <provider-string>``.

Downloads the provider's history into memory (nothing is written into the
workdir's ``data``), runs the script on it, then keeps running on the provider's
live feed. Data only: the bridge never trades.
With ``--data-only`` the chart has no script: an empty indicator
(:data:`CANDLES_SCRIPT`) runs in its place, so only the candles stream and no
output file is written.
It has no broker flag and never creates a broker; a provider plugin that is
also a broker only streams market data here, like any data provider.

Events on top of a backtest's stream:

- ``download``: the history download's progress (``step``: ``symbolInfo``,
  ``history`` with ``done``/``total`` seconds of the window, ``retry`` with the
  ``attempt``, the ``delay`` before it and the ``message`` of the failure).
- ``live``: the history is over, every later bar comes from the live feed.
- ``tick``: the forming bar's latest update, at most :data:`TICK_INTERVAL_SECONDS`
  apart, the latest one wins. ``d`` is a ``bars`` row; ``ran`` tells whether the
  script ran on it. When it ran, ``colors`` holds every dynamic color channel,
  ``drawings`` the drawing changes against the last closed bar, and a
  strategy's ``trades`` the trades the bar closed so far and ``openTrades``
  the trades open after it. All of it is provisional: the next tick replaces
  it, the bar's close (a ``bars`` row with the same timestamp) supersedes it.
  Without a run only the candle is new.
- ``openTrades`` (a strategy's): the full set of open trades, sent at the
  transition and after every closed bar that changed it. Each set replaces
  the previous one; an empty set means no trade is open.
- ``feedStatus``: the live feed's state (``connecting``, ``live``,
  ``reconnecting`` with ``attempt``/``offlineSeconds``/``error``,
  ``market_closed``, ``stopped``).

A ``bars`` row whose timestamp equals the previous row's replaces it: the
history's last bar may still have been forming when it was downloaded, and the
live feed then delivers its close.
"""

from __future__ import annotations

import inspect
import os
import sys
import threading
import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .control import Control
from .protocol import Emitter, num_or_none

#: Minimum seconds between two ``tick`` events.
TICK_INTERVAL_SECONDS = 0.1

#: Minimum seconds between two ``download`` progress events.
DOWNLOAD_PROGRESS_INTERVAL_SECONDS = 0.1

#: The ``kind`` of the error a PyneCore without live chart support gets.
UNSUPPORTED_KIND = "LiveUnsupported"

#: Default size limit of a live run's plot CSV and viz NDJSON together, in MB.
DEFAULT_OUTPUT_LIMIT_MB = 256

#: Bytes in an MB of ``--live-output-limit``.
BYTES_PER_MB = 1024 * 1024


class LiveCancelled(Exception):
    """The run was stopped before the live feed started."""


class TickThrottle:
    """Emits ``tick`` events at most one per interval; the latest one wins.

    A tick held back is sent by a timer when the interval is over, so the chart
    gets the latest price also when no further update comes. Emitting under the
    lock makes :meth:`drop` final: no held tick goes out after it returns.
    """

    def __init__(self, emitter: Emitter, interval: float = TICK_INTERVAL_SECONDS):
        self._emitter = emitter
        self._interval = interval
        self._lock = threading.Lock()
        self._last = float("-inf")
        self._pending: dict[str, Any] | None = None
        self._timer: threading.Timer | None = None

    def offer(self, event: dict[str, Any]) -> None:
        with self._lock:
            wait = self._last + self._interval - time.monotonic()
            if wait <= 0 and self._pending is None:
                self._send(event)
                return
            self._pending = event
            if self._timer is None:
                self._timer = threading.Timer(max(wait, 0.0), self._fire)
                self._timer.daemon = True
                self._timer.start()

    def drop(self) -> None:
        """Forget the held tick: the bar it belongs to has closed."""
        with self._lock:
            self._pending = None
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None

    def _fire(self) -> None:
        with self._lock:
            self._timer = None
            if self._pending is not None:
                event, self._pending = self._pending, None
                self._send(event)

    def _send(self, event: dict[str, Any]) -> None:
        self._emitter.emit(event)
        self._last = time.monotonic()


class OutputCap:
    """Stops writing a live run's plot CSV and viz NDJSON once the two files
    together reach a size.

    The files are what a chart reopened without a run shows, so they end as
    complete records at the bar of the limit: the viz file gets its drawings
    snapshot and end record, the CSV is closed. The chart stream goes on.
    """

    def __init__(self, runner: Any, paths: list[Path], limit_mb: int, emitter: Emitter):
        self._runner = runner
        self._paths = paths
        self._limit_mb = limit_mb
        self._emitter = emitter
        self.reached = False

    def size(self) -> int:
        """The current size of the files, in bytes."""
        return sum(path.stat().st_size for path in self._paths if path.exists())

    def check(self) -> None:
        """Stop the files when they reached the limit; called after each closed bar."""
        if self.reached or self.size() < self._limit_mb * BYTES_PER_MB:
            return
        self.reached = True
        plot_writer = self._runner.plot_writer
        if plot_writer is not None:
            # The runner checks the attribute on every bar and at its end
            self._runner.plot_writer = None
            plot_writer.close()
        viz_writer = self._runner.viz_writer
        if viz_writer is not None:
            viz_writer.finish()
        self._emitter.emit({
            "e": "log", "level": "warning",
            "message": f"the live run's output files reached {self._limit_mb} MB: later bars are "
                       "shown on the chart but not saved",
        })


class LiveFeed:
    """The live part of a run: what :func:`~pyneide_bridge.runner._stream_run`
    needs to stream the forming bar.

    :ivar runs_on_ticks: Whether the script runs on every live update (always for
        an indicator, with ``calc_on_every_tick`` for a strategy).
    :ivar active: Set once the history is over.
    :ivar output_cap: The size limit of the output files, checked after each live
        bar close.
    """

    def __init__(self, emitter: Emitter, runs_on_ticks: bool,
                 output_cap: OutputCap | None = None):
        self.ticks = TickThrottle(emitter)
        self.runs_on_ticks = runs_on_ticks
        self.active = False
        self.output_cap = output_cap

    @staticmethod
    def watch_transition(source: Iterator[Any], on_live: Callable[[], None]) -> Iterator[Any]:
        """Call ``on_live`` when the runner moves past the end of the history.

        The runner reads one item ahead, so it takes the transition marker
        while it still runs the last history bar. Its next read comes after
        that bar was streamed: that is the moment the live phase starts, before
        the first live update arrives (which can take a whole bar).
        """
        from pynecore.core.script_runner import LIVE_TRANSITION

        for item in source:
            yield item
            if item is LIVE_TRANSITION:
                on_live()
                yield from source
                return


class _DownloadReporter:
    """Streams the history download's progress as ``download`` events; a
    stopped run aborts the download at its next progress report."""

    def __init__(self, emitter: Emitter, control: Control):
        from pynecore.core.provider_download import DownloadListener

        reporter = self

        class Listener(DownloadListener):
            def symbol_info_started(self) -> None:
                reporter.check()
                emitter.emit({"e": "download", "step": "symbolInfo"})

            def download_attempt(self, time_from: Any, total_seconds: int) -> None:
                reporter.check()
                reporter.total = total_seconds
                emitter.emit({"e": "download", "step": "history", "done": 0,
                              "total": total_seconds})

            def download_progress(self, elapsed_seconds: int) -> None:
                reporter.check()
                now = time.monotonic()
                if now - reporter.last_progress >= DOWNLOAD_PROGRESS_INTERVAL_SECONDS:
                    reporter.last_progress = now
                    emitter.emit({"e": "download", "step": "history",
                                  "done": elapsed_seconds, "total": reporter.total})

            def warning(self, message: str) -> None:
                emitter.emit({"e": "log", "level": "warning", "message": message})

            def retry_wait(self, error: BaseException, delay: float, attempt: int) -> None:
                reporter.check()
                emitter.emit({"e": "download", "step": "retry", "attempt": attempt,
                              "delay": delay, "message": str(error)})

        self.listener = Listener()
        self.total = 0
        self.last_progress = float("-inf")
        self._control = control

    def check(self) -> None:
        if self._control.cancelled:
            raise LiveCancelled()


def _feed_status_event(status: Any) -> dict[str, Any]:
    return {
        "e": "feedStatus",
        "state": status.state,
        "attempt": status.attempt,
        "offlineSeconds": num_or_none(status.offline_seconds),
        "error": status.error,
    }


def live_supported() -> str | None:
    """Why this PyneCore cannot run a live chart, or ``None`` when it can."""
    unsupported = "this PyneCore cannot run live charts; update PyneCore"
    try:
        from pynecore.core.provider_download import (download_provider_history_resilient,
                                                     open_live_stream)
        from pynecore.core.script_runner import ScriptRunner
    except ImportError:
        return unsupported
    download_params = inspect.signature(download_provider_history_resilient).parameters
    if "stop" not in inspect.signature(open_live_stream).parameters \
            or "stop" not in download_params or "in_memory" not in download_params \
            or "yield_ticks" not in inspect.signature(ScriptRunner.run_iter).parameters \
            or "live_history_trades" not in inspect.signature(ScriptRunner).parameters:
        return unsupported
    return None


#: The script of a live chart without one: an empty overlay indicator.
CANDLES_SCRIPT = Path(__file__).with_name("live_candles.py")

#: Backtest options a live run does not take, with their flag names.
_BACKTEST_ONLY = (
    ("data", "--data"), ("time_from", "--time-from"),
    ("time_to", "--time-to"), ("timeframe", "--timeframe"), ("security", "--security"),
    ("debugpy_port", "--debugpy-port"), ("profile", "--profile"),
    ("robustness", "--robustness"),
)


def run_live(args: Any, emitter: Emitter, control: Control) -> int:
    """Run the script on a provider's history, then on its live feed. With
    ``--data-only`` the chart has no script: the run streams the candles only
    and writes no output file."""
    from . import runner as backtest

    reason = live_supported()
    if reason is not None:
        emitter.emit({"e": "error", "message": reason, "kind": UNSUPPORTED_KIND,
                      "traceback": ""})
        return 1
    for attr, flag in _BACKTEST_ONLY:
        value = getattr(args, attr, None)
        if value not in (None, False):
            raise ValueError(f"{flag} cannot be used with --live")
    if args.live_output_limit is not None and args.live_output_limit < 0:
        raise ValueError("--live-output-limit cannot be negative")
    data_only = bool(getattr(args, "data_only", False))
    if data_only and (args.history_trades or args.live_output_limit is not None):
        raise ValueError("--history-trades and --live-output-limit need a script, "
                         "not --data-only")

    from pynecore.core.live_runner import LiveStop
    from pynecore.core.provider_download import (DownloadStopped,
                                                 download_provider_history_resilient,
                                                 open_live_stream, require_live_provider)
    from pynecore.core.script_runner import ScriptRunner

    workdir = Path(args.workdir).resolve()
    if data_only:
        script = CANDLES_SCRIPT
        # The script lives in the extension: no settings file is written beside it
        os.environ["PYNE_SAVE_SCRIPT_TOML"] = "0"
    else:
        script = backtest._resolve_script(workdir, args.script)

    # Stops a download retry wait and the live stream
    stop = LiveStop()
    # A signal handler may run the hook while the main thread holds the
    # stream's queue lock: set the stop from a thread of its own.
    control.add_cancel_hook(
        lambda: threading.Thread(target=stop.set, name="pyneide-live-stop", daemon=True).start())

    reporter = _DownloadReporter(emitter, control)
    try:
        history = download_provider_history_resilient(
            args.live, args.live_from, data_dir=workdir / "data", config_dir=workdir / "config",
            retry_transient=True, listener=reporter.listener, stop=stop,
            # The history is not saved: a file would replace a dataset of the
            # same symbol and timeframe the user downloaded
            in_memory=True)
        require_live_provider(history)
    except (LiveCancelled, DownloadStopped):
        emitter.emit({"e": "end", "bars": 0, "cancelled": True})
        return 0

    syminfo = history.syminfo
    bars = history.bars
    assert bars is not None
    if data_only:
        plot_path = strat_path = trade_path = viz_path = None
    else:
        output_dir = workdir / "output"
        output_dir.mkdir(parents=True, exist_ok=True)
        plot_path = output_dir / f"{script.stem}.csv"
        strat_path = output_dir / f"{script.stem}_strat.csv"
        trade_path = output_dir / f"{script.stem}_trade.csv"
        viz_path = output_dir / f"{script.stem}_viz.ndjson"
        # Stale results of an earlier backtest of the script
        (output_dir / f"{script.stem}_robustness.json").unlink(missing_ok=True)

        lib_dir = workdir / "scripts" / "lib"
        if lib_dir.is_dir():
            sys.path.insert(0, str(lib_dir))

    time_from_ts = history.time_from_ts if history.time_from_ts is not None \
        else (bars[0].timestamp if bars else 0)
    time_to_ts = bars[-1].timestamp if bars else time_from_ts
    window = [bar for bar in bars if time_from_ts <= bar.timestamp <= time_to_ts]
    size = len(window)
    last_bar_time = window[-1].timestamp if window else None

    runner = ScriptRunner(
        script, iter(window), syminfo,
        # The live run's bar count is open-ended, as in ``pyne run --live``
        last_bar_index=-1,
        last_bar_time=last_bar_time,
        live=True,
        live_history_trades=bool(args.history_trades),
        history_as_of=history.as_of_ts,
        plot_path=plot_path, strat_path=strat_path, trade_path=trade_path,
        viz_path=viz_path,
        chart_provider_name=history.parsed_string.provider,
        chart_provider_instance=history.provider_instance,
        # The security contexts download their history from the chart's start
        time_from=datetime.fromtimestamp(time_from_ts / 1000, UTC),
        config_dir=workdir / "config",
    )
    output_cap: OutputCap | None = None
    if viz_path is not None:
        runner.viz_writer = backtest._make_viz_writer(viz_path, args.live, runner)
        limit_mb = args.live_output_limit if args.live_output_limit is not None \
            else DEFAULT_OUTPUT_LIMIT_MB
        if limit_mb > 0:
            output_cap = OutputCap(runner, [plot_path, viz_path], limit_mb, emitter)
    is_strategy = backtest._script_type_name(runner.script) == "strategy"
    runs_on_ticks = not is_strategy or bool(getattr(runner.script, "calc_on_every_tick",
                                                    False))

    emitter.emit({
        "e": "start",
        "script": "" if data_only else str(script),
        "scriptTitle": "" if data_only else getattr(runner.script, "title", "") or "",
        "scriptShortTitle": "" if data_only else getattr(runner.script, "shorttitle", "") or "",
        "scriptType": backtest._script_type_name(runner.script),
        "overlay": bool(getattr(runner.script, "overlay", False)),
        "initialCapital": num_or_none(runner.script.initial_capital)
        if is_strategy else None,
        **({"dataOnly": True} if data_only else {}),
        "syminfo": backtest._serialize_syminfo(syminfo),
        "data": args.live,
        "range": {"from": time_from_ts, "to": time_to_ts, "bars": size},
        "live": {"provider": args.live, "historyTrades": bool(args.history_trades)},
        "outputs": {
            "plot": str(plot_path) if plot_path is not None else "",
            "strat": str(strat_path) if is_strategy else None,
            "trades": str(trade_path) if is_strategy else None,
            "viz": str(viz_path) if viz_path is not None else None,
            "profile": None,
            "robustness": None,
        },
    })

    # The stream connects at once: the bars that close while the history
    # runs arrive as its catch-up, none is lost in between
    live_iter = open_live_stream(
        history, last_historical_timestamp=time_to_ts,
        on_feed_status=lambda status: emitter.emit(_feed_status_event(status)),
        stop=stop,
    )
    runner.ohlcv_iter = _chain(runner.ohlcv_iter, live_iter)

    return backtest._stream_run(runner, emitter, control,
                                total_bars=size,
                                is_strategy=is_strategy,
                                batch_size=args.batch_size,
                                chart_breakpoints=False,
                                live=LiveFeed(emitter, runs_on_ticks, output_cap))


def _chain(history: Iterator[Any], live: Iterator[Any]) -> Iterator[Any]:
    """History bars, then the live stream; closing it closes the stream too."""
    try:
        yield from history
        yield from live
    finally:
        close = getattr(live, "close", None)
        if close is not None:
            close()
