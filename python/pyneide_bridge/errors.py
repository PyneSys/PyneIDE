"""The ``error`` event of a failed bridge call.

A run stopped by a coded PyneCore error (``R0010``, ...) also carries the
code, its parameters, the bar and the location the run found, so the IDE
reads them instead of mining the traceback. The user picks the PyneCore
release; one from before the coded errors has none, and its events carry
the message, the kind and the traceback alone.
"""

import traceback
from typing import Any

def error_event(exc: BaseException) -> dict[str, Any]:
    """The ``error`` event of ``exc``, raised in the ``except`` block handling it.

    :param exc: The exception.
    :return: The event.
    """
    event: dict[str, Any] = {
        "e": "error",
        "message": str(exc),
        "kind": type(exc).__name__,
        "traceback": traceback.format_exc(),
    }
    # Imported here, not with the module: the bridge sets the run's environment
    # up before anything imports pynecore
    try:
        from pynecore.core.errors import PyneError, format_arg
    except ImportError:  # a PyneCore release before the coded errors
        return event
    if not isinstance(exc, PyneError):
        return event
    at = exc.at
    event.update({
        "code": exc.code.code,
        "params": {name: format_arg(value) for name, value in exc.params.items()},
        "bar": exc.bar_index,
        "time": exc.bar_time,
        "at": None if at is None else {"module": at.module, "path": at.path, "line": at.line,
                                       "col": at.col, "pineLine": at.pine_line},
        "inSecurity": exc.in_security,
    })
    return event
