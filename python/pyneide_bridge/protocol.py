"""NDJSON protocol emitter.

One JSON object per line on the protocol stream. The emitter is thread-safe:
the stdin control thread emits state acknowledgements while the main thread
streams bars.
"""

from __future__ import annotations

import json
import math
import threading
from typing import Any, BinaryIO


def sanitize(value: Any) -> Any:
    """Make a value JSON-safe: non-finite floats become None, unknown types
    become their ``str()`` form. NaN is pynecore's ``na``, so None is the
    faithful wire representation."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    return str(value)


def num_or_none(value: Any) -> float | None:
    """Numeric plot/price value, or None for na / non-numeric values."""
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        f = float(value)
        return f if math.isfinite(f) else None
    return None


class Emitter:
    def __init__(self, stream: BinaryIO):
        self._stream = stream
        self._lock = threading.Lock()

    def emit(self, event: dict[str, Any]) -> None:
        line = json.dumps(event, ensure_ascii=False, separators=(",", ":"),
                          allow_nan=False).encode("utf-8")
        with self._lock:
            self._stream.write(line + b"\n")
            self._stream.flush()
