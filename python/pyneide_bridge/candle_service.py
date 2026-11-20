"""Candle service: the live charts without a script of a workdir, in one process.

A chart without a script needs the provider's candles only, so it runs no
``ScriptRunner``: every chart is a thread that downloads the history into memory
and then follows the live feed. The process is meant to run as a client of the
workdir's provider hub, which holds the provider SDKs and connections; without a
hub it builds the providers itself.

Commands, one JSON object per stdin line:

- ``{"cmd": "open", "chart": N, "provider": "...", "from": "..."}`` starts a chart
  (``from`` is optional: the history start, as ``--live-from``).
- ``{"cmd": "close", "chart": N}`` stops it.

Every event of a chart is the event a ``--live --data-only`` run sends (see
:mod:`~pyneide_bridge.live`), with the chart's number added as ``chart``. After its
last event one ``{"e": "exit", "chart": N, "code": C}`` follows, ``C`` being the exit
code the run would have had. One ``{"e": "candles"}`` event tells that the service
takes commands. The process ends when stdin closes.
"""

import json
import sys
import threading
import time
from pathlib import Path
from typing import Any

from pynecore.core.live_runner import LiveStop
from pynecore.core.provider_download import (DownloadStopped, download_provider_history_resilient,
                                             open_live_stream, require_live_provider)
# noinspection PyProtectedMember
from pynecore.core.script_runner import LIVE_TRANSITION, _clean_bar
from pynecore.core.syminfo import mintick_decimals

from .errors import error_event
from .live import (LiveCancelled, TickThrottle, UNSUPPORTED_KIND, _DownloadReporter,
                   _feed_status_event, live_supported)
from .protocol import Emitter, num_or_none
from .runner import FLUSH_AGE_SECONDS, _serialize_syminfo

#: Bars per ``bars`` event while the history streams.
BATCH_SIZE = 500

#: How long the process waits for its charts to stop once stdin closed.
SHUTDOWN_TIMEOUT = 15.0


class _ChartEmitter:
    """Sends a chart's events with the chart's number on them."""

    def __init__(self, emitter: Emitter, chart: int):
        self._emitter = emitter
        self._chart = chart

    def emit(self, event: dict[str, Any]) -> None:
        self._emitter.emit({**event, "chart": self._chart})


class _StopState:
    """What the download reporter asks about a chart: whether it was stopped."""

    def __init__(self, stop: LiveStop):
        self._stop = stop

    @property
    def cancelled(self) -> bool:
        return self._stop.is_set


def stream_candles(provider: str, time_from: str | None, workdir: Path, emitter: Any,
                   stop: LiveStop) -> int:
    """Stream a provider's candles: the history, then the live feed.

    The rows are the ones a script's run sends for the same bars: the prices and the
    volume go through the clean-up the script runner applies to a chart bar.

    :param provider: The provider string, with the timeframe.
    :param time_from: The history start (a date, days, or ``-N`` bars).
    :param workdir: Resolved pyne workdir.
    :param emitter: Receives the events.
    :param stop: Ends the download and the stream when set.
    :return: The exit code.
    """
    reason = live_supported()
    if reason is not None:
        emitter.emit({"e": "error", "message": reason, "kind": UNSUPPORTED_KIND,
                      "traceback": ""})
        return 1

    reporter = _DownloadReporter(emitter, _StopState(stop))
    try:
        history = download_provider_history_resilient(
            provider, time_from, data_dir=workdir / "data", config_dir=workdir / "config",
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
    time_from_ts = history.time_from_ts if history.time_from_ts is not None \
        else (bars[0].timestamp if bars else 0)
    time_to_ts = bars[-1].timestamp if bars else time_from_ts
    window = [bar for bar in bars if time_from_ts <= bar.timestamp <= time_to_ts]
    size = len(window)
    mintick = getattr(syminfo, "mintick", 0.0) or 0.0
    round_decimals = mintick_decimals(mintick) if mintick > 0 else None

    emitter.emit({
        "e": "start",
        "script": "",
        "scriptTitle": "",
        "scriptShortTitle": "",
        "scriptType": "indicator",
        "overlay": True,
        "initialCapital": None,
        "dataOnly": True,
        "syminfo": _serialize_syminfo(syminfo),
        "data": provider,
        "range": {"from": time_from_ts, "to": time_to_ts, "bars": size},
        "live": {"provider": provider, "historyTrades": False},
        "outputs": {"plot": "", "strat": None, "trades": None, "viz": None,
                    "profile": None, "robustness": None},
    })

    def row(candle: Any) -> list[Any]:
        o, h, lo, c, v = _clean_bar(candle, round_decimals, False, False)
        return [int(candle.timestamp), num_or_none(o), num_or_none(h), num_or_none(lo),
                num_or_none(c), num_or_none(v), None]

    batch: list[list[Any]] = []
    bars_done = 0
    # Timestamp of the newest bar row
    last_row_ts: int | None = None
    last_flush = time.monotonic()

    def flush(progress: bool) -> None:
        nonlocal batch, last_flush
        if batch:
            emitter.emit({"e": "bars", "d": batch})
            batch = []
        if progress:
            emitter.emit({"e": "progress", "done": bars_done, "total": size})
        last_flush = time.monotonic()

    def add_bar(candle: Any) -> None:
        """Queue a closed bar's row; a later version of the newest bar replaces it."""
        nonlocal bars_done, last_row_ts
        timestamp = int(candle.timestamp)
        if last_row_ts is not None and timestamp < last_row_ts:
            return
        if timestamp == last_row_ts and batch:
            batch[-1] = row(candle)
            return
        if timestamp != last_row_ts:
            bars_done += 1
        last_row_ts = timestamp
        batch.append(row(candle))

    ticks = TickThrottle(emitter)
    # The stream connects at once: the bars that close while the history
    # streams arrive as its catch-up, none is lost in between
    stream = open_live_stream(
        history, last_historical_timestamp=time_to_ts,
        on_feed_status=lambda status: emitter.emit(_feed_status_event(status)),
        stop=stop,
    )
    try:
        for candle in window:
            if stop.is_set:
                break
            add_bar(candle)
            if len(batch) >= BATCH_SIZE or time.monotonic() - last_flush > FLUSH_AGE_SECONDS:
                flush(True)
        live = False
        # Timestamp of the newest bar the live feed closed
        last_closed_ts: int | None = None
        # Timestamp of the bar the feed is on
        current_ts = last_row_ts
        for update in stream:
            if update is LIVE_TRANSITION:
                flush(True)
                live = True
                emitter.emit({"e": "live"})
                continue
            if not live:
                # The catch-up: bars that closed while the history streamed
                add_bar(update)
                current_ts = last_row_ts
                continue
            timestamp = int(update.timestamp)
            # A bar the feed already closed is settled, and time never runs backwards:
            # the same updates a script's run drops
            if last_closed_ts is not None and timestamp <= last_closed_ts:
                continue
            if current_ts is not None and timestamp < current_ts:
                continue
            current_ts = timestamp
            if not update.is_closed:
                ticks.offer({"e": "tick", "ran": True, "d": row(update)})
                continue
            # The close supersedes every tick of its bar still held back
            ticks.drop()
            last_closed_ts = timestamp
            add_bar(update)
            flush(False)
    finally:
        ticks.drop()
        # Tears the live stream down
        stream.close()

    flush(False)
    emitter.emit({"e": "end", "bars": bars_done, "cancelled": stop.is_set})
    return 0


class CandleService:
    """Runs the charts the IDE opens, each on a thread of its own."""

    def __init__(self, workdir: Path, emitter: Emitter):
        self._workdir = workdir
        self._emitter = emitter
        self._lock = threading.Lock()
        self._charts: dict[int, tuple[LiveStop, threading.Thread]] = {}

    def serve(self) -> None:
        """Block reading stdin until EOF, then stop every chart."""
        self._emitter.emit({"e": "candles"})
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            chart = msg.get("chart")
            if not isinstance(chart, int):
                continue
            cmd = msg.get("cmd")
            if cmd == "open":
                provider = msg.get("provider")
                time_from = msg.get("from")
                if isinstance(provider, str) and (time_from is None or isinstance(time_from, str)):
                    self._open(chart, provider, time_from)
            elif cmd == "close":
                self._close(chart)
        self._shutdown()

    def _open(self, chart: int, provider: str, time_from: str | None) -> None:
        stop = LiveStop()
        thread = threading.Thread(target=self._run, args=(chart, provider, time_from, stop),
                                  name=f"pyneide-candles-{chart}", daemon=True)
        with self._lock:
            if chart in self._charts:
                return
            self._charts[chart] = (stop, thread)
        thread.start()

    def _close(self, chart: int) -> None:
        with self._lock:
            entry = self._charts.get(chart)
        if entry is not None:
            entry[0].set()

    def _run(self, chart: int, provider: str, time_from: str | None, stop: LiveStop) -> None:
        emitter = _ChartEmitter(self._emitter, chart)
        try:
            code = stream_candles(provider, time_from, self._workdir, emitter, stop)
        except Exception as exc:
            emitter.emit(error_event(exc))
            code = 1
        with self._lock:
            self._charts.pop(chart, None)
        emitter.emit({"e": "exit", "code": code})

    def _shutdown(self) -> None:
        with self._lock:
            charts = list(self._charts.values())
        for stop, _ in charts:
            stop.set()
        deadline = time.monotonic() + SHUTDOWN_TIMEOUT
        for _, thread in charts:
            thread.join(max(deadline - time.monotonic(), 0.0))
