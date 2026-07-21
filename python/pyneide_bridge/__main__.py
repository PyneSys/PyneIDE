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
from pathlib import Path


def _hijack_stdout():
    proto = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)  # everything else writing to fd 1 goes to stderr
    return proto


def main() -> int:
    proto_stream = _hijack_stdout()

    from . import PROTOCOL_VERSION
    from . import control as control_module
    from .control import Control, start_stdin_reader
    from .protocol import Emitter

    parser = argparse.ArgumentParser(prog="pyneide_bridge")
    parser.add_argument("--script", default=None,
                        help="Pyne .py script (bare name resolves in workdir/scripts); "
                             "not required with --data-only")
    parser.add_argument("--data", default=None,
                        help=".ohlcv data file (bare name resolves in workdir/data); "
                             "not required with --inspect-inputs")
    parser.add_argument("--workdir", required=True, help="Resolved pyne workdir")
    parser.add_argument("--inspect-inputs", default=None, metavar="SCRIPT",
                        help="One-shot: import SCRIPT and print its collected input "
                             "declarations as JSON, without running it")
    parser.add_argument("--write-inputs", default=None, metavar="SCRIPT",
                        help="One-shot: read {name: value} JSON from stdin and persist it "
                             "to SCRIPT's sibling .toml via pynecore's canonical writer")
    parser.add_argument("--data-only", action="store_true",
                        help="Stream the raw .ohlcv candles without running a script "
                             "(chart preview); ignores --script/--debugpy-port")
    parser.add_argument("--provider-service", action="store_true",
                        help="Long-lived NDJSON RPC endpoint for the symbol browser "
                             "(providers/brokers/symbols/syminfo/download); ignores "
                             "--script/--data")
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
    parser.add_argument("--debugpy-port", type=int, default=None,
                        help="Start a debugpy listener on this port (0 = pick a free "
                             "one) and wait for the IDE to attach before running")
    args = parser.parse_args()

    emitter = Emitter(proto_stream)
    emitter.emit({"e": "hello", "protocol": PROTOCOL_VERSION, "pid": os.getpid()})

    # PYNE_WORK_DIR keeps pynecore-internal workdir discovery consistent with
    # the IDE's resolved workdir, whatever the folder is named.
    os.environ.setdefault("PYNE_WORK_DIR", args.workdir)

    if args.provider_service:
        # The service owns stdin (its own RPC reader); no run Control here.
        from .provider_service import ProviderService
        try:
            ProviderService(Path(args.workdir).resolve(), emitter).serve()
            return 0
        except Exception as exc:
            emitter.emit({
                "e": "error",
                "message": str(exc),
                "kind": type(exc).__name__,
                "traceback": traceback.format_exc(),
            })
            return 1

    # inspect/write are one-shot and own stdin themselves (write reads the JSON
    # values from it), so they run BEFORE the run Control's stdin reader would
    # otherwise swallow it — same as --provider-service above.
    if args.inspect_inputs:
        from .runner import inspect_inputs
        try:
            return inspect_inputs(args, emitter)
        except Exception as exc:
            emitter.emit({
                "e": "error",
                "message": str(exc),
                "kind": type(exc).__name__,
                "traceback": traceback.format_exc(),
            })
            return 1

    if args.write_inputs:
        from .runner import write_inputs
        try:
            return write_inputs(args, emitter)
        except Exception as exc:
            emitter.emit({
                "e": "error",
                "message": str(exc),
                "kind": type(exc).__name__,
                "traceback": traceback.format_exc(),
            })
            return 1

    control = Control(on_state=lambda state: emitter.emit({"e": "state", "state": state}))
    # Publish for the debug proxy's run-to-bar evaluate (see control.request_runto).
    control_module.ACTIVE_CONTROL = control
    start_stdin_reader(control)

    # SIGTERM/SIGINT stop the run at the next bar boundary so the runner's
    # cleanup (stats CSV, security subprocess teardown) still executes.
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, lambda *_: control.cancel())
        except (ValueError, OSError):
            pass

    if not args.data:
        emitter.emit({"e": "error", "message": "--data is required for a run",
                      "kind": "ValueError", "traceback": ""})
        return 1

    if args.data_only:
        from .runner import run_data_only
        try:
            return run_data_only(args, emitter, control)
        except Exception as exc:
            emitter.emit({
                "e": "error",
                "message": str(exc),
                "kind": type(exc).__name__,
                "traceback": traceback.format_exc(),
            })
            return 1

    if not args.script:
        emitter.emit({"e": "error", "message": "--script is required for a run",
                      "kind": "ValueError", "traceback": ""})
        return 1

    if args.debugpy_port is not None:
        # Listen + wait BEFORE the user script is imported (the import hook
        # transform runs at import), so breakpoints set during the DAP
        # handshake bind before any user code executes. Safe after the fd
        # hijack: the adapter subprocess inherits fd 1 already pointing at
        # stderr, so it cannot corrupt the NDJSON stream.
        import debugpy
        host, port = debugpy.listen(("127.0.0.1", args.debugpy_port))
        emitter.emit({"e": "debugpy", "host": host, "port": port})
        debugpy.wait_for_client()

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
