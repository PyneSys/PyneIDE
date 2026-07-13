"""Run control: stdin command reader + pause/resume/step/cancel state.

Commands are JSON lines on stdin:

    {"cmd": "pause"}
    {"cmd": "resume"}
    {"cmd": "step", "bars": 1}   # while paused: advance N bars, pause again
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
        # True whenever the main loop must leave the hot path.
        self.idle = False
        self._on_state = on_state

    def _wake(self) -> None:
        self.idle = self._paused or self._cancelled
        self._cond.notify_all()

    def pause(self) -> None:
        with self._cond:
            if not self._paused:
                self._paused = True
                self._step_budget = 0
                self._wake()
                if self._on_state:
                    self._on_state("paused")

    def resume(self) -> None:
        with self._cond:
            if self._paused:
                self._paused = False
                self._step_budget = 0
                self._wake()
                if self._on_state:
                    self._on_state("running")

    def step(self, bars: int) -> None:
        with self._cond:
            if self._paused and bars > 0:
                self._step_budget = bars
                self._cond.notify_all()

    def cancel(self) -> None:
        with self._cond:
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
