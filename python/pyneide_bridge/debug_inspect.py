"""Frame introspection for the IDE-side debug adapter proxy.

The proxy composes three variable scopes at a stop, each fed by one helper
here (evaluated in the stopped frame via pydevd ``evaluate``):

* **Pyne** (:func:`pine_bar`) — the current bar's live runtime values
  (``bar_index`` + OHLCV + derived sources + ``time``), read straight off
  ``pynecore.lib``, regardless of what the script imports. A dashboard of
  "where am I", not scope-accessible names.
* **Locals** (:func:`pine_slots`) — the named persistent/series state of the
  stopped scope. At runtime the transform stores these in anonymous
  ``__state__[N]`` slots; the source names survive only in the module's
  ``__pyne_slot_layout__``. The proxy injects them alongside the frame's real
  locals.
* **Globals** (:func:`pine_globals`) — what the script's module scope actually
  exposes: the value sources it imported (``from pynecore.lib import close``,
  rewritten to ``lib.close`` by the transform, so reconstructed from the
  original source file) plus the user's module-level constants. The pynecore
  module noise (imported modules, classes, the script functions, dunders) is
  left out.

Everything here must be side-effect free: it runs against a live, suspended
script. Each result is base64-encoded JSON, because the evaluate response
carries ``repr(str)`` and base64 keeps that trivially parseable.
"""

from __future__ import annotations

import ast
import base64
import importlib
import json
import os
import types
from typing import Any

_STATE_PREFIX = "__state·"  # scope-qualified hidden param: __state·main__

# The Pyne scope: the current bar's essence, read straight off ``pynecore.lib``
# (the runner sets these per bar as plain scalars). ``bar_index`` leads because
# "which bar am I on" is the first question at a breakpoint. ``bid``/``ask`` are
# intentionally omitted — pynecore always reports them ``na`` (no tick data), so
# they would only add ``nan`` noise.
_BAR_NAMES = (
    "bar_index",
    "open", "high", "low", "close", "volume",
    "hl2", "hlc3", "ohlc4", "hlcc4",
    "time",
)

# The built-in price sources a script can import from ``pynecore.lib``; used to
# recover which of a script's imports are value sources for the Globals scope.
_SOURCE_NAMES = frozenset({
    "open", "high", "low", "close", "volume", "bid", "ask",
    "hl2", "hlc3", "ohlc4", "hlcc4",
})

# path -> (mtime, mapping display-name -> lib source-name) for imported sources.
_import_cache: dict[str, tuple[float, dict[str, str]]] = {}


def _fmt(value: Any) -> str:
    try:
        return repr(value)
    except Exception:  # a __repr__ that raises must not break inspection
        return "<unrepr>"


def _is_source_sentinel(value: Any) -> bool:
    """True for an unresolved ``Source`` placeholder (source not in this feed)."""
    try:
        from pynecore.types.source import Source
    except Exception:
        return False
    return isinstance(value, Source)


def _lib():
    try:
        return importlib.import_module("pynecore.lib")
    except Exception:
        return None


def _is_module_property(value: Any) -> bool:
    """True for a Pine hybrid property (a ``@module_property`` lib function).

    Such a name reads as a value in Pine — a bare ``time`` compiles to
    ``lib.time()`` (see ``ModulePropertyTransformer``). The decorator stamps
    ``__module_property__`` on the function, and only these are safe to call
    with no arguments; plain lib functions (``na`` and friends, which need an
    argument) and namespace modules (``dayofweek``) carry no such marker.
    """
    return callable(value) and getattr(value, "__module_property__", False) is True


def _resolve(value: Any) -> Any:
    """Evaluate a module property to its current value; pass anything else
    through unchanged.

    Mirrors the transform's bare-read rewrite: a module property is a function
    at runtime, but semantically a value, so a zero-arg call yields the current
    bar's value instead of showing ``<function time at 0x…>``.
    """
    if _is_module_property(value):
        try:
            return value()
        except Exception:
            return value
    return value


def _bar_datetime(lib: Any, time_ms: int) -> str | None:
    """Human-readable exchange-timezone datetime for a bar time (Unix ms).

    ``time`` is a Unix millisecond timestamp; on the Pyne dashboard a date is
    more legible. ``lib._get_dt(ms, None)`` converts it in the exchange
    timezone (the ``None`` timezone default — the same one the chart shows).
    """
    get_dt = getattr(lib, "_get_dt", None)
    if get_dt is None:
        return None
    try:
        return get_dt(time_ms, None).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def pine_bar() -> str:
    """Current ``bar_index`` + OHLCV/derived sources + ``time`` from ``lib``.

    ``time`` is kept as its raw Unix-ms value (what the Pine code sees); a
    derived ``datetime`` entry renders the same instant in the exchange
    timezone for readability.

    :return: base64 of ``[{name, value, type}]``.
    """
    lib = _lib()
    out: list[dict[str, Any]] = []
    if lib is not None:
        time_ms: int | None = None
        for name in _BAR_NAMES:
            try:
                value = _resolve(getattr(lib, name))
            except Exception:
                continue
            if _is_source_sentinel(value):
                continue
            if name == "time" and isinstance(value, int) and not isinstance(value, bool):
                time_ms = value
            out.append({"name": name, "value": _fmt(value), "type": type(value).__name__})
        if time_ms is not None:
            dt = _bar_datetime(lib, time_ms)
            if dt is not None:
                out.append({"name": "datetime", "value": dt, "type": "str"})
    return base64.b64encode(json.dumps(out).encode("utf-8")).decode("ascii")


def _imported_sources(path: str) -> dict[str, str]:
    """Value-like lib names the script imports (display-name -> lib name).

    Covers the built-in price sources (``close`` …) and the Pine module
    properties (``time`` …). The ``ImportNormalizer`` transform strips the
    original ``from pynecore.lib import close`` and rewrites ``close`` to
    ``lib.close``, so the imported names are gone from the runtime module
    namespace; they are recovered by parsing the original source file (cached
    by mtime). Callers pass each recovered value through :func:`_resolve`, so a
    module property is shown/bound as its current value, not as a function.
    """
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        return {}
    cached = _import_cache.get(path)
    if cached is not None and cached[0] == mtime:
        return cached[1]
    mapping: dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            tree = ast.parse(f.read())
    except (OSError, SyntaxError, ValueError):
        return {}
    lib = _lib()
    for node in tree.body:
        if not isinstance(node, ast.ImportFrom) or not node.module:
            continue
        if node.module != "pynecore.lib" and not node.module.startswith("pynecore.lib."):
            continue
        for alias in node.names:
            if alias.name in _SOURCE_NAMES or _is_module_property(getattr(lib, alias.name, None)):
                mapping[alias.asname or alias.name] = alias.name
    _import_cache[path] = (mtime, mapping)
    return mapping


def _is_constant(name: str, value: Any) -> bool:
    """A user module-level constant worth showing in Globals.

    Keeps plain literal values (the script's ``TT_* = "..."`` constants); drops
    dunders, the normalized ``lib`` import, imported modules, classes and
    functions — the Python plumbing that buries the script's own globals.
    """
    if name.startswith("__") or name == "lib":
        return False
    if isinstance(value, (types.ModuleType, type)) or callable(value):
        return False
    return isinstance(value, (str, int, float, bool, bytes, tuple, frozenset)) or value is None


def pine_globals(frame_globals: dict[str, Any]) -> str:
    """The script's meaningful module globals: imported sources + constants.

    :param frame_globals: The frame's ``globals()`` (pydevd evaluate context).
    :return: base64 of ``[{name, value, type}]``.
    """
    out: list[dict[str, Any]] = []
    lib = _lib()
    path = frame_globals.get("__file__")
    imported: dict[str, str] = {}
    if lib is not None and isinstance(path, str):
        imported = _imported_sources(path)
        for display, real in imported.items():
            try:
                value = _resolve(getattr(lib, real))
            except Exception:
                continue
            if _is_source_sentinel(value):
                continue
            out.append({"name": display, "value": _fmt(value), "type": type(value).__name__})
    for name in sorted(frame_globals):
        # Skip the imported sources: they are listed above, and ``bind_sources``
        # injects them into the module globals (so watch expressions resolve),
        # which would otherwise make them re-appear here as bare constants.
        if name in imported:
            continue
        value = frame_globals[name]
        if _is_constant(name, value):
            out.append({"name": name, "value": _fmt(value), "type": type(value).__name__})
    return base64.b64encode(json.dumps(out).encode("utf-8")).decode("ascii")


def bind_sources(frame_globals: dict[str, Any]) -> int:
    """Bind the script's imported source / module-property names into globals.

    The ``ImportNormalizer`` transform rewrites ``close`` to ``lib.close`` and
    strips the import, so a bare ``close`` in a watch expression is a NameError;
    a module property such as ``time`` is further rewritten to a ``lib.time()``
    call. This binds each imported source / module property (only those the
    script actually imports) to its current value in the module globals — a
    module property to its resolved (called) value, not the function — so
    watch/repl expressions like ``close``, ``ta.sma(close, 14)`` or ``time``
    resolve. The transformed code never reads the bare names (always ``lib.*``),
    so this has no effect on execution;
    a real local of the same name still shadows it (locals resolve first). Call
    at every stop to refresh the values.

    :param frame_globals: The frame's ``globals()`` (the module dict).
    :return: The number of names bound.
    """
    lib = _lib()
    path = frame_globals.get("__file__")
    if lib is None or not isinstance(path, str):
        return 0
    bound = 0
    for display, real in _imported_sources(path).items():
        try:
            value = _resolve(getattr(lib, real))
        except Exception:
            continue
        if _is_source_sentinel(value):
            continue
        frame_globals[display] = value
        bound += 1
    return bound


def _scope_base(scope: str) -> str:
    """Owner function name of a layout scope key.

    Scope keys join the def-name path with the middle dot (``main·helper``)
    and disambiguate repeated names with an ordinal (``highest·2``).
    """
    segments = scope.split("·")
    if len(segments) >= 2 and segments[-1].isdigit():
        return segments[-2]
    return segments[-1]


def _owner_of(param: str, frame_name: str) -> str:
    """Which function's state a hidden parameter carries.

    The default param name (``__state__``) belongs to the frame's own
    function; a scope-qualified name (``__state·main__``) is a closure
    reference to that function's state.
    """
    if param == "__state__":
        return frame_name
    return param[len(_STATE_PREFIX):-2]


def _match_layout(layouts: dict[str, Any], owner: str, state: list) -> dict[str, Any] | None:
    for scope, layout in layouts.items():
        try:
            if _scope_base(scope) == owner and len(layout["init"]) == len(state):
                return layout
        except (KeyError, TypeError):
            continue
    return None


def pine_slots(frame_locals: dict[str, Any], frame_globals: dict[str, Any],
               frame_name: str) -> str:
    """List the named Pine state slots reachable from a stopped frame.

    :param frame_locals: The frame's ``locals()`` (pydevd evaluate context).
    :param frame_globals: The frame's ``globals()``.
    :param frame_name: The frame's function name (from the DAP stack trace).
    :return: base64 of ``[{name, param, slot, kind, owner, own}]``.
    """
    layouts = frame_globals.get("__pyne_slot_layout__") or {}
    slots: list[dict[str, Any]] = []
    for param, state in frame_locals.items():
        is_qualified = param.startswith(_STATE_PREFIX) and param.endswith("__")
        if param != "__state__" and not is_qualified:
            continue
        if not isinstance(state, list):
            continue
        owner = _owner_of(param, frame_name)
        layout = _match_layout(layouts, owner, state)
        if layout is None:
            continue
        names = layout.get("names") or ()
        series_slots = {slot for slot, _mbb in layout.get("series", ())}
        child_slots = {slot for slot, _cid, _loop in layout.get("children", ())}
        seen: set[str] = set()
        for i in range(len(state)):
            name = names[i] if i < len(names) else None
            # A name repeating after its first slot is a companion slot
            # (lazy-init flag, kahan sum); the first slot holds the value.
            if not name or i in child_slots or name in seen:
                continue
            seen.add(name)
            slots.append({
                "name": name,
                "param": param,
                "slot": i,
                "kind": "series" if i in series_slots else "var",
                "owner": owner,
                "own": owner == frame_name,
            })
    return base64.b64encode(json.dumps(slots).encode("utf-8")).decode("ascii")
