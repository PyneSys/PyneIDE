"""Run control: stdin command reader + pause/resume/step/cancel state.

Commands are JSON lines on stdin:

    {"cmd": "pause"}
    {"cmd": "resume"}
    {"cmd": "step", "bars": 1}   # while paused: advance N bars, pause again
    {"cmd": "chartBreakpoints", "timestamps": [1710000000000]}
    {"cmd": "cancel"}

The per-bar hot path is a single attribute check (``control.idle``); the
condition variable is only touched when paused. This is the foundation for
bar-stepping in the debugger phase too.
"""

from __future__ import annotations

import json
import sys
import threading
from typing import Callable


class Control:
    def __init__(self, on_state: Callable[[str], None] | None = None):
        self._cond = threading.Condition()
        self._paused = False
        self._cancelled = False
        self._step_budget = 0
        # "Run to bar N": when set, the feed self-pauses once it has processed
        # this many bars. Checked on the FEED thread (note_bar), so — unlike an
        # stdin pause, which the reader thread cannot deliver while pydevd has
        # every thread suspended at a breakpoint — it is race-free: the debugger
        # sets it via an `evaluate` before releasing the run (see request_runto).
        self._runto: int | None = None
        # Pure chart breakpoints are scheduled outside pydevd. The runner reads
        # this immutable snapshot before each chart bar and parks only at a
        # matching timestamp; replacing a frozenset is atomic under the GIL, so
        # the per-bar hot path needs neither this condition lock nor tracing.
        self._chart_breakpoints: frozenset[int] = frozenset()
        # A chart-breakpoint park is internal handoff state. It must not flash
        # the regular paused/running UI while the IDE installs/removes the real
        # line breakpoint around the one matching bar.
        self._silent_pause = False
        # True whenever the main loop must leave the hot path.
        self.idle = False
        self._on_state = on_state

    def _wake(self) -> None:
        self.idle = self._paused or self._cancelled
        self._cond.notify_all()

    def set_runto(self, bar: int | None) -> None:
        with self._cond:
            self._runto = bar

    def set_chart_breakpoints(self, timestamps: object) -> None:
        if not isinstance(timestamps, list):
            self._chart_breakpoints = frozenset()
            return
        self._chart_breakpoints = frozenset(
            value for value in timestamps
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0
        )

    def has_chart_breakpoint(self, timestamp: int) -> bool:
        """Lock-free hot-path lookup for a chart bar timestamp."""
        return timestamp in self._chart_breakpoints

    def park_chart_breakpoint(self) -> bool:
        """Silently park the feed while the IDE changes debugpy breakpoints."""
        with self._cond:
            if self._cancelled or self._paused:
                return False
            self._paused = True
            self._step_budget = 0
            self._silent_pause = True
            self._wake()
            return True

    def note_bar(self, bars_done: int) -> None:
        """Feed-thread hook, called after each processed bar. Self-pauses the
        run once the run-to-bar target is reached — race-free because it runs on
        the feed thread, not via stdin."""
        with self._cond:
            if self._runto is not None and bars_done >= self._runto:
                self._runto = None
                if not self._paused:
                    self._paused = True
                    self._step_budget = 0
                    self._wake()
                    if self._on_state:
                        self._on_state("paused")

    def pause(self) -> None:
        with self._cond:
            self._runto = None
            if not self._paused:
                self._paused = True
                self._step_budget = 0
                self._silent_pause = False
                self._wake()
                if self._on_state:
                    self._on_state("paused")

    def resume(self) -> None:
        with self._cond:
            self._runto = None
            if self._paused:
                silent = self._silent_pause
                self._paused = False
                self._step_budget = 0
                self._silent_pause = False
                self._wake()
                if self._on_state and not silent:
                    self._on_state("running")

    def step(self, bars: int) -> None:
        with self._cond:
            self._runto = None
            if self._paused and bars > 0:
                self._step_budget = bars
                self._cond.notify_all()

    def cancel(self) -> None:
        with self._cond:
            self._runto = None
            self._cancelled = True
            self._wake()

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    def gate(self) -> bool:
        """Per-bar gate. Returns True to process the next bar, False when the
        run was cancelled. Blocks while paused (unless a step budget allows
        bars through)."""
        if not self.idle:
            return True
        with self._cond:
            while True:
                if self._cancelled:
                    return False
                if not self._paused:
                    return True
                if self._step_budget > 0:
                    self._step_budget -= 1
                    return True
                self._cond.wait()


# The live Control of the current run, published so the IDE-side debug proxy can
# reach it with an `evaluate` while the debuggee is suspended at a breakpoint
# (stdin is dead then — pydevd has every thread frozen). request_runto is the
# race-free way to arm "run to bar N": it runs in-process, on the debuggee.
ACTIVE_CONTROL: Control | None = None


def request_runto(bar: int) -> bool:
    """Arm the active run's run-to-bar target. Returns True if a run is live."""
    if ACTIVE_CONTROL is None:
        return False
    ACTIVE_CONTROL.set_runto(bar)
    return True


def start_stdin_reader(control: Control) -> threading.Thread:
    def reader() -> None:
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    cmd = msg.get("cmd")
                except (ValueError, AttributeError):
                    continue
                if cmd == "pause":
                    control.pause()
                elif cmd == "resume":
                    control.resume()
                elif cmd == "step":
                    try:
                        control.step(int(msg.get("bars", 1)))
                    except (TypeError, ValueError):
                        control.step(1)
                elif cmd == "chartBreakpoints":
                    control.set_chart_breakpoints(msg.get("timestamps"))
                elif cmd == "cancel":
                    control.cancel()
                    break
        except Exception:
            pass
        # stdin EOF: the IDE side is gone, stop the run instead of orphaning.
        control.cancel()

    t = threading.Thread(target=reader, name="pyneide-control", daemon=True)
    t.start()
    return t
