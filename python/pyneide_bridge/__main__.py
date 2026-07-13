"""Entry point: ``python -m pyneide_bridge --script X --data Y --workdir W``.

The FIRST thing done here — before pynecore or the user script can print
anything — is stealing fd 1 for the NDJSON protocol and pointing regular
stdout at stderr. User ``print()`` calls and pynecore logs therefore land in
the IDE's log channel instead of corrupting the event stream.
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import traceback


def _hijack_stdout():
    proto = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)  # everything else writing to fd 1 goes to stderr
    return proto


def main() -> int:
    proto_stream = _hijack_stdout()

    from . import PROTOCOL_VERSION
    from .control import Control, start_stdin_reader
    from .protocol import Emitter

    parser = argparse.ArgumentParser(prog="pyneide_bridge")
    parser.add_argument("--script", required=True,
                        help="Pyne .py script (bare name resolves in workdir/scripts)")
    parser.add_argument("--data", required=True,
                        help=".ohlcv data file (bare name resolves in workdir/data)")
    parser.add_argument("--workdir", required=True, help="Resolved pyne workdir")
    parser.add_argument("--time-from", type=int, default=None,
                        help="Start of the run window (epoch seconds, UTC)")
    parser.add_argument("--time-to", type=int, default=None,
                        help="End of the run window (epoch seconds, UTC)")
    parser.add_argument("--timeframe", default=None,
                        help="Chart timeframe override (TradingView format)")
    parser.add_argument("--security", action="append", default=None,
                        metavar="KEY=DATA",
                        help='Security data mapping: "TIMEFRAME=file" or "SYMBOL:TIMEFRAME=file"')
    parser.add_argument("--batch-size", type=int, default=500,
                        help="Bars per NDJSON flush")
    args = parser.parse_args()

    emitter = Emitter(proto_stream)
    emitter.emit({"e": "hello", "protocol": PROTOCOL_VERSION, "pid": os.getpid()})

    control = Control(on_state=lambda state: emitter.emit({"e": "state", "state": state}))
    start_stdin_reader(control)

    # SIGTERM/SIGINT stop the run at the next bar boundary so the runner's
    # cleanup (stats CSV, security subprocess teardown) still executes.
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, lambda *_: control.cancel())
        except (ValueError, OSError):
            pass

    # PYNE_WORK_DIR keeps pynecore-internal workdir discovery consistent with
    # the IDE's resolved workdir, whatever the folder is named.
    os.environ.setdefault("PYNE_WORK_DIR", args.workdir)

    from .runner import run
    try:
        return run(args, emitter, control)
    except Exception as exc:
        emitter.emit({
            "e": "error",
            "message": str(exc),
            "kind": type(exc).__name__,
            "traceback": traceback.format_exc(),
        })
        return 1


if __name__ == "__main__":
    sys.exit(main())
