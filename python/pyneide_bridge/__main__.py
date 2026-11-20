"""Entry point: ``python -m pyneide_bridge --script X --data Y --workdir W``.

The FIRST thing done here — before pynecore or the user script can print
anything — is stealing fd 1 for the NDJSON protocol and pointing regular
stdout at stderr. User ``print()`` calls and pynecore logs therefore land in
the IDE's log channel instead of corrupting the event stream.
"""

from __future__ import annotations

import argparse
import builtins
import logging
import os
import signal
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from .protocol import Emitter


def _hijack_stdout():
    proto = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)  # everything else writing to fd 1 goes to stderr
    return proto


class _ScriptLogSignal(logging.Filter):
    """Announce the run's first script output line with one ``scriptLog`` event.

    The script's output reaches the IDE through stderr, mixed with pynecore's own
    ``[BROKER]``, ``[SIM]`` and ``[OHLCV]`` lines, which share the Pine log logger. Only
    the records the Pine ``log.info`` / ``log.warning`` / ``log.error`` functions write
    and the ``print()`` calls (the script's own and ``alert()``'s) are the script's
    output, so the IDE reveals its log channel on this event instead of on any stderr
    line. The log handler writes through its console's file, never through ``print()``,
    so wrapping ``print`` sees no pynecore log line.
    """

    _PINE_LOG_FUNCTIONS = frozenset(("info", "warning", "error"))

    def __init__(self, emitter: Emitter, log_module_path: str):
        super().__init__()
        self._emitter = emitter
        self._log_module_path = log_module_path
        self._sent = False

    def filter(self, record: logging.LogRecord) -> bool:
        if (record.funcName in self._PINE_LOG_FUNCTIONS
                and record.pathname == self._log_module_path):
            self.signal()
        return True

    def signal(self) -> None:
        """Emit the ``scriptLog`` event, once per run."""
        if not self._sent:
            self._sent = True
            self._emitter.emit({"e": "scriptLog"})

    def wrap_print(self, print_function: Callable[..., None]) -> Callable[..., None]:
        """Wrap ``print`` so its first successful call that writes to the captured stdout
        or stderr sends the ``scriptLog`` event.

        The captured streams are the ``sys.stdout`` / ``sys.stderr`` objects at wrap time
        and any stream on fd 1 or 2; all of them reach the IDE's log channel (fd 1 is
        pointed at stderr). A print to any other file, including one that
        ``contextlib.redirect_stdout`` makes the default, never shows up there, so it does
        not use up the run's reveal.
        """
        captured = (sys.stdout, sys.stderr, sys.__stdout__, sys.__stderr__)

        def reaches_log_channel(target: Any) -> bool:
            if any(target is stream for stream in captured):
                return True
            try:
                return target.fileno() in (1, 2)
            except (AttributeError, OSError, ValueError):
                return False

        def signalling_print(*args: Any, **kwargs: Any) -> None:
            print_function(*args, **kwargs)
            if self._sent:
                return
            target = kwargs.get("file")
            if reaches_log_channel(sys.stdout if target is None else target):
                self.signal()
        return signalling_print


def main() -> int:
    proto_stream = _hijack_stdout()

    from . import PROTOCOL_VERSION
    from . import control as control_module
    from .control import Control, start_stdin_reader
    from .errors import error_event
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
    parser.add_argument("--inspect-security", default=None, metavar="SCRIPT",
                        help="One-shot: import SCRIPT and print its request.security() data "
                             "requirements (against --data's syminfo) as JSON, without running it")
    parser.add_argument("--data-only", action="store_true",
                        help="Stream the raw .ohlcv candles without running a script "
                             "(chart preview); ignores --script/--debugpy-port. With --live: "
                             "a live chart of the candles only, no output files")
    parser.add_argument("--provider-service", action="store_true",
                        help="Long-lived NDJSON RPC endpoint for the symbol browser "
                             "(providers/brokers/symbols/syminfo/download); ignores "
                             "--script/--data")
    parser.add_argument("--hub", action="store_true",
                        help="With --provider-service: also serve the workdir's live runs "
                             "as their provider hub (needs a PyneCore with "
                             "pynecore.core.plugin.hub)")
    parser.add_argument("--hub-port", type=int, default=0, metavar="PORT",
                        help="With --hub: port the hub listens on (default: a free one)")
    parser.add_argument("--live", default=None, metavar="PROVIDER_STRING",
                        help="Live chart: download the provider string's history "
                             "(e.g. ccxt:BYBIT:BTC/USDT:USDT@1) into memory, run "
                             "--script on it, then on the provider's live feed. Data only, "
                             "no trading; replaces --data")
    parser.add_argument("--live-from", default=None, metavar="FROM",
                        help="History start of --live: a date, days, or -N bars "
                             "(default: -500 bars)")
    parser.add_argument("--history-trades", action="store_true",
                        help="With --live on a strategy: trade on the history bars too and "
                             "carry that position into the live phase (default: start flat)")
    parser.add_argument("--live-output-limit", type=int, default=None, metavar="MB",
                        help="With --live: stop saving the plot CSV and viz NDJSON once they "
                             "reach MB together, the chart goes on (default: 256, 0: no "
                             "limit)")
    parser.add_argument("--inputs", default=None, metavar="JSON",
                        help="With --live: input values as a JSON object keyed by the main() "
                             "parameter name; they override the script's .toml for this run "
                             "only")
    parser.add_argument("--settings", default=None, metavar="JSON",
                        help="With --live: script settings (decorator arguments such as "
                             "initial_capital) as a JSON object; they override the script's "
                             ".toml for this run only")
    parser.add_argument("--output-dir", default=None, metavar="DIR",
                        help="With --live: write the output files here (relative to the "
                             "workdir) instead of workdir/output")
    parser.add_argument("--output-name", default=None, metavar="NAME",
                        help="With --live: the output file name stem instead of the script's")
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
    parser.add_argument("--profile", action="store_true",
                        help="Profile the run per source line and write "
                             "output/<stem>_profile.json (pynecore's profiler)")
    parser.add_argument("--robustness", default=None, metavar="JSON",
                        help="Strategy runs: after the last bar, run the robustness tests "
                             "(settings as a JSON object) and write "
                             "output/<stem>_robustness.json")
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
            if args.hub:
                try:
                    from .provider_hub import serve_with_hub
                except ModuleNotFoundError as exc:
                    # The IDE reads this line: it then runs without a hub
                    print(f"ModuleNotFoundError: {exc}", file=sys.stderr, flush=True)
                    return 1
                return serve_with_hub(Path(args.workdir).resolve(), emitter, args.hub_port)
            ProviderService(Path(args.workdir).resolve(), emitter).serve()
            return 0
        except Exception as exc:
            emitter.emit(error_event(exc))
            return 1

    # inspect/write are one-shot and own stdin themselves (write reads the JSON
    # values from it), so they run BEFORE the run Control's stdin reader would
    # otherwise swallow it — same as --provider-service above.
    if args.inspect_inputs:
        from .runner import inspect_inputs
        try:
            return inspect_inputs(args, emitter)
        except Exception as exc:
            emitter.emit(error_event(exc))
            return 1

    if args.write_inputs:
        from .runner import write_inputs
        try:
            return write_inputs(args, emitter)
        except Exception as exc:
            emitter.emit(error_event(exc))
            return 1

    if args.inspect_security:
        from .runner import inspect_security
        try:
            return inspect_security(args, emitter)
        except Exception as exc:
            emitter.emit(error_event(exc))
            return 1

    from pynecore.lib import log as pine_log
    script_log_signal = _ScriptLogSignal(emitter, pine_log.__file__)
    pine_log.logger.addFilter(script_log_signal)
    builtins.print = script_log_signal.wrap_print(builtins.print)

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

    if args.live is not None:
        if not args.script and not args.data_only:
            emitter.emit({"e": "error", "message": "--script is required for a run",
                          "kind": "ValueError", "traceback": ""})
            return 1
        from .live import run_live
        try:
            return run_live(args, emitter, control)
        except Exception as exc:
            emitter.emit(error_event(exc))
            return 1
    if (args.history_trades or args.live_from is not None or args.live_output_limit is not None
            or args.inputs is not None or args.settings is not None
            or args.output_dir is not None or args.output_name is not None):
        emitter.emit({"e": "error",
                      "message": "--history-trades, --live-from, --live-output-limit, --inputs, "
                                 "--settings, --output-dir and --output-name need --live",
                      "kind": "ValueError", "traceback": ""})
        return 1

    if not args.data:
        emitter.emit({"e": "error", "message": "--data is required for a run",
                      "kind": "ValueError", "traceback": ""})
        return 1

    if args.data_only:
        from .runner import run_data_only
        try:
            return run_data_only(args, emitter, control)
        except Exception as exc:
            emitter.emit(error_event(exc))
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
        emitter.emit(error_event(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
