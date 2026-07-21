"""Provider service mode: a long-lived NDJSON RPC endpoint over stdin/stdout.

Unlike the run modes (which execute one script/data set and exit), this mode
stays alive and answers requests from the IDE's symbol browser: enumerate
providers, list a broker's symbols, fetch live symbol info, download OHLCV with
streamed progress. It is the CLI-free sibling of the ``pyne data`` TUI —
everything data-provider related routes through pynecore's ``core`` layer, no
typer/rich.

Wire format (one JSON object per line):

    request   {"cmd": "rpc", "id": N, "method": "...", "params": {...}}
    cancel    {"cmd": "cancel", "id": N}          # N = the in-flight request id
    result    {"e": "result", "id": N, "result": ...}
    error     {"e": "result", "id": N, "error": {"kind","message","retryable"}}
    progress  {"e": "progress", "id": N, "done": ..., "total": ...}

The provider instances carry mutable per-symbol state, so browse requests run
on a single worker thread (serialized, mirroring the TUI's one-worker rule). A
download runs on its own thread against a *separate* provider instance, so a
long download never corrupts the symbol info the browser is fetching in the
background.
"""

from __future__ import annotations

import dataclasses
import json
import math
import os
import sys
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, time
from pathlib import Path
from typing import Any

from pynecore.core.config import ensure_config
from pynecore.core.download_runner import (DownloadProgress, DownloadPlan,
                                           download_to_file)
from pynecore.core.plugin import (ProviderPlugin, discover_plugins,
                                   get_plugin_metadata, get_plugin_summary,
                                   is_retryable_provider_error, load_plugin)
from pynecore.core.syminfo import SymInfo

from .protocol import Emitter

_SYMINFO_CACHE_MAX = 200


class _DownloadCancelled(Exception):
    """Raised inside the progress callback to abort an in-flight download."""


def _jsonify(value: Any) -> Any:
    """Recursively coerce a SymInfo field to a JSON-safe value: times/dates to
    ISO strings, NamedTuples (opening_hours / session rows) to dicts, non-finite
    floats to None (pynecore's ``na``)."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, time):
        return value.isoformat()
    if isinstance(value, date):  # date and datetime
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _jsonify(v) for k, v in value.items()}
    # NamedTuple (SymInfoInterval / SymInfoSession / SymInfoScheduleVariant)
    fields = getattr(type(value), "_fields", None)
    if fields is not None:
        return {f: _jsonify(getattr(value, f)) for f in fields}
    if isinstance(value, (list, tuple)):
        return [_jsonify(v) for v in value]
    return str(value)


def serialize_syminfo(info: SymInfo) -> dict[str, Any]:
    """Serialize a full SymInfo — flat fields plus the opening_hours / session
    arrays — to a JSON-safe dict."""
    return {f.name: _jsonify(getattr(info, f.name))
            for f in dataclasses.fields(info)}


def _list_providers() -> list[dict[str, Any]]:
    """All installed provider plugins with their display metadata."""
    out: list[dict[str, Any]] = []
    for name, ep in sorted(discover_plugins().items()):
        try:
            cls = ep.load()
        except Exception:
            continue
        if not (isinstance(cls, type) and issubclass(cls, ProviderPlugin)):
            continue
        meta = get_plugin_metadata(ep)
        out.append({
            "name": name,
            "display_name": getattr(cls, "plugin_name", "") or name,
            "multi_broker": bool(getattr(cls, "multi_broker", False)),
            "summary": get_plugin_summary(cls) or meta["description"],
        })
    return out


class ProviderService:
    def __init__(self, workdir: Path, emitter: Emitter):
        self.workdir = workdir
        self.emitter = emitter
        self.config_dir = workdir / "config"
        data_env = os.environ.get("PYNE_DATA_DIR")
        self.data_dir = Path(data_env) if data_env else workdir / "data"

        # Provider mutable state forces serialization: one worker for all browse
        # requests (providers/brokers/symbols/syminfo/syminfo_file).
        self._browse_pool = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="pyneide-browse")
        # Browse instances, keyed (provider, broker). Touched only on the single
        # browse worker, so no lock needed here.
        self._provider_cache: dict[tuple[str, str | None], ProviderPlugin] = {}

        self._cache_lock = threading.Lock()
        self._syminfo_cache: "OrderedDict[tuple[str, str | None, str], dict[str, Any]]" = OrderedDict()

        self._lock = threading.Lock()
        self._cancelled: set[int] = set()
        self._download_thread: threading.Thread | None = None
        self._download_id: int | None = None
        self._download_cancel = threading.Event()

    # ---- reader loop --------------------------------------------------

    def serve(self) -> None:
        """Block reading stdin until EOF, dispatching each request."""
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            cmd = msg.get("cmd")
            if cmd == "rpc":
                self._dispatch(msg)
            elif cmd == "cancel":
                self._cancel(msg.get("id"))
        self._shutdown()

    def _dispatch(self, msg: dict[str, Any]) -> None:
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        if not isinstance(rid, int) or not isinstance(method, str):
            return
        if method == "download":
            self._start_download(rid, params)
        else:
            self._browse_pool.submit(self._run_method, rid, method, params)

    def _cancel(self, target_id: Any) -> None:
        if not isinstance(target_id, int):
            return
        with self._lock:
            if target_id == self._download_id:
                self._download_cancel.set()
                return
            self._cancelled.add(target_id)

    def _shutdown(self) -> None:
        self._download_cancel.set()
        self._browse_pool.shutdown(wait=False, cancel_futures=True)

    # ---- browse methods (run on the single browse worker) -------------

    def _run_method(self, rid: int, method: str, params: dict[str, Any]) -> None:
        try:
            result = self._call(method, params)
        except Exception as exc:
            if not self._is_cancelled(rid):
                self._emit_error(rid, exc)
            return
        if self._is_cancelled(rid):
            return
        self.emitter.emit({"e": "result", "id": rid, "result": result})

    def _is_cancelled(self, rid: int) -> bool:
        with self._lock:
            if rid in self._cancelled:
                self._cancelled.discard(rid)
                return True
        return False

    def _call(self, method: str, params: dict[str, Any]) -> Any:
        if method == "providers":
            return _list_providers()
        if method == "brokers":
            return self._brokers(params)
        if method == "symbols":
            return self._symbols(params)
        if method == "syminfo":
            return self._syminfo(params)
        if method == "syminfo_file":
            return self._syminfo_file(params)
        raise ValueError(f"Unknown method: {method!r}")

    def _resolve_provider_class(self, provider_name: str) -> type[ProviderPlugin]:
        cls = load_plugin(provider_name)
        if not (isinstance(cls, type) and issubclass(cls, ProviderPlugin)):
            raise ValueError(f"Plugin '{provider_name}' is not a data provider.")
        return cls

    def _get_config(self, provider_class: type[ProviderPlugin],
                    provider_name: str) -> object | None:
        config_cls: type | None = getattr(provider_class, "Config", None)
        if config_cls is None:
            return None
        return ensure_config(
            config_cls, self.config_dir / "plugins" / f"{provider_name}.toml")

    def _make_provider(self, provider_name: str,
                       broker: str | None) -> ProviderPlugin:
        """Construct a symbol-less provider instance for browsing / downloading.

        Multi-broker providers take the broker selector through ``symbol`` (they
        recognize a broker-only value and leave ``self.symbol`` None), which is
        how the exchange context gets baked into the instance."""
        provider_class = self._resolve_provider_class(provider_name)
        config = self._get_config(provider_class, provider_name)
        if provider_class.multi_broker and broker:
            return provider_class(symbol=broker, timeframe=None, config=config)
        return provider_class(symbol=None, timeframe=None, config=config)

    def _browse_provider(self, provider_name: str,
                         broker: str | None) -> ProviderPlugin:
        key = (provider_name, broker)
        inst = self._provider_cache.get(key)
        if inst is None:
            inst = self._make_provider(provider_name, broker)
            self._provider_cache[key] = inst
        return inst

    def _brokers(self, params: dict[str, Any]) -> dict[str, Any]:
        provider_class = self._resolve_provider_class(params["provider"])
        try:
            brokers = provider_class.get_list_of_brokers()
        except NotImplementedError:
            return {"supported": False, "brokers": []}
        return {
            "supported": True,
            "brokers": [{"id": b.id, "name": b.name} for b in sorted(brokers)],
        }

    def _symbols(self, params: dict[str, Any]) -> list[str]:
        inst = self._browse_provider(params["provider"], params.get("broker"))
        return inst.get_list_of_symbols()

    def _syminfo(self, params: dict[str, Any]) -> dict[str, Any]:
        provider = params["provider"]
        broker = params.get("broker")
        symbol = params["symbol"]
        key = (provider, broker, symbol)
        with self._cache_lock:
            cached = self._syminfo_cache.get(key)
            if cached is not None:
                self._syminfo_cache.move_to_end(key)
                return cached
        inst = self._browse_provider(provider, broker)
        # Symbol info is timeframe-independent (only SymInfo.period labels a
        # timeframe, cosmetic here). update_symbol_info() reads self.symbol and
        # never writes a file (unlike get_symbol_info), so browsing does not
        # litter the data dir with .toml.
        inst.symbol = symbol
        data = serialize_syminfo(inst.update_symbol_info())
        with self._cache_lock:
            self._syminfo_cache[key] = data
            self._syminfo_cache.move_to_end(key)
            while len(self._syminfo_cache) > _SYMINFO_CACHE_MAX:
                self._syminfo_cache.popitem(last=False)
        return data

    def _syminfo_file(self, params: dict[str, Any]) -> dict[str, Any]:
        path = Path(params["path"])
        if not path.is_absolute():
            path = self.data_dir / path
        return serialize_syminfo(SymInfo.load_toml(path))

    # ---- download (own thread, own provider instance) -----------------

    def _start_download(self, rid: int, params: dict[str, Any]) -> None:
        with self._lock:
            if self._download_thread is not None and self._download_thread.is_alive():
                self._emit_error(
                    rid, RuntimeError("A download is already in progress"))
                return
            self._download_cancel = threading.Event()
            self._download_id = rid
            t = threading.Thread(
                target=self._run_download,
                args=(rid, params, self._download_cancel),
                name="pyneide-download", daemon=True)
            self._download_thread = t
        t.start()

    def _run_download(self, rid: int, params: dict[str, Any],
                      cancel_event: threading.Event) -> None:
        try:
            provider_name = params["provider"]
            broker = params.get("broker")
            symbol = params["symbol"]
            timeframe = params["timeframe"]
            truncate = bool(params.get("truncate", False))
            time_from = self._parse_from(params["from"])
            time_to = datetime.fromtimestamp(int(params["to"]), UTC)

            # A dedicated instance: never the cached browse one, so a background
            # download cannot mutate the symbol under the browser's cursor.
            inst = self._make_provider(provider_name, broker)

            def on_start(plan: DownloadPlan) -> None:
                self.emitter.emit({
                    "e": "progress", "id": rid, "done": 0,
                    "total": plan.total_seconds, "indeterminate": plan.fetch_all,
                })

            def on_progress(progress: DownloadProgress) -> None:
                if cancel_event.is_set():
                    raise _DownloadCancelled()
                self.emitter.emit({
                    "e": "progress", "id": rid,
                    "done": progress.elapsed_seconds,
                    "total": progress.total_seconds,
                })

            provider_string = (f"{provider_name}:{broker}:{symbol}@{timeframe}"
                               if broker
                               else f"{provider_name}:{symbol}@{timeframe}")

            result = download_to_file(
                inst,
                symbol=symbol, timeframe=timeframe, ohlcv_dir=self.data_dir,
                time_from=time_from, time_to=time_to, truncate=truncate,
                on_start=on_start, on_progress=on_progress,
                on_conflict="abort", provider_string=provider_string,
            )

            self.emitter.emit({
                "e": "result", "id": rid,
                "result": {
                    "ohlcv_path": str(result.ohlcv_path),
                    "bars_written": result.bars_written,
                    "from": int(result.time_from.replace(tzinfo=UTC).timestamp()),
                    "to": int(result.time_to.replace(tzinfo=UTC).timestamp()),
                    "fetch_all": result.fetch_all,
                    "syminfo": serialize_syminfo(result.syminfo)
                    if result.syminfo is not None else None,
                },
            })
        except _DownloadCancelled:
            self.emitter.emit({
                "e": "result", "id": rid,
                "error": {"kind": "Cancelled",
                          "message": "Download cancelled", "retryable": False},
            })
        except Exception as exc:
            self._emit_error(rid, exc)
        finally:
            with self._lock:
                self._download_id = None

    @staticmethod
    def _parse_from(value: Any) -> datetime | str:
        if value == "continue":
            return "continue"
        return datetime.fromtimestamp(int(value), UTC)

    # ---- errors -------------------------------------------------------

    def _emit_error(self, rid: int, exc: Exception) -> None:
        self.emitter.emit({
            "e": "result", "id": rid,
            "error": {
                "kind": type(exc).__name__,
                "message": str(exc) or repr(exc),
                "retryable": is_retryable_provider_error(exc),
            },
        })
