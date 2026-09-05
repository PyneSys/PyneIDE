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
import re
import sys
import types
from typing import Any

_STATE_PREFIX = "__state·"  # scope-qualified hidden param: __state·main__

# PyneComp renames a user identifier only by APPENDING a suffix, and the suffix
# shapes are part of its stable ABI (see pynecomp renames.py): a block-scope
# suffix (``x__global__`` / ``x__0000002a__``, extra trailing underscores dodge
# same-named source identifiers) for variables colliding with a function/
# import/module name (every variable in --strict mode), and the canonical
# ``__ren__`` (class-body ``__ren___``) for exported functions, UDT fields and
# keyword-shaped names. The Pine original is recoverable from the name alone.
_MANGLE_SCOPE_RE = re.compile(r"(.+?)__(?:global|[0-9a-f]{8})__+")
_MANGLE_REN_RE = re.compile(r"(.+?)__ren___?")


def _demangle(name: str) -> str | None:
    """The Pine name behind a compiler-renamed identifier, or None."""
    m = _MANGLE_SCOPE_RE.fullmatch(name) or _MANGLE_REN_RE.fullmatch(name)
    return m.group(1) if m else None


def _bind_demangled(ns: dict[str, Any]) -> None:
    """Alias compiler-renamed names in an eval namespace to their Pine originals.

    A watch/condition is written in Pine terms (``basis``), while the runtime
    binding may be the renamed ``basis__global__``. ``setdefault`` keeps a real
    binding of the bare name authoritative (it shadows the alias).
    """
    for name in list(ns.keys()):
        base = _demangle(name)
        if base:
            ns.setdefault(base, ns[name])

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


# Python scalar type names that read differently in Pine (Python ``str`` is
# Pine's ``string``); everything else keeps its Python name (``int``, ``float``,
# ``bool``, or a user class).
_PINE_TYPE_ALIAS = {"str": "string"}


def _pine_elem_type(value: Any) -> str:
    """Pine element-type name of a runtime value (for ``Series[...]`` labels).

    ``NA`` sentinels carry their element type in ``.type`` (``NA[float]`` ->
    ``float``); the inf/nan valued-NA markers behave as ``float``. A live scalar
    reports its Python type name, aliased where Pine differs (``str`` ->
    ``string``).
    """
    try:
        from pynecore.types.na import NA
    except Exception:
        NA = None  # type: ignore[assignment]
    if NA is not None and isinstance(value, NA):
        t = value.type
        if t is None or hasattr(t, "_na_value"):
            return "float"
        return getattr(t, "__name__", None) or "float"
    name = type(value).__name__
    return _PINE_TYPE_ALIAS.get(name, name)


def _slot_type_label(value: Any, is_series: bool) -> str:
    """Source-level type of a state slot: ``Series[float]`` / ``Persistent[int]``.

    The element type is read from the live value — the current bar's scalar for a
    persistent variable, the newest buffered value for a series (both match what
    the developer declared, e.g. ``basis: Series[float]``).
    """
    if is_series:
        try:
            elem = _pine_elem_type(value[0]) if len(value) > 0 else "float"
        except Exception:
            elem = "float"
        return f"Series[{elem}]"
    return f"Persistent[{_pine_elem_type(value)}]"


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


def _bar_values() -> dict[str, Any]:
    """Current bar builtins as live values (``bar_index`` + OHLCV + derived +
    ``time``), read straight off ``pynecore.lib``.

    Unlike :func:`pine_bar` these are the real Python objects, not formatted
    strings: they seed the namespace a conditional breakpoint is evaluated in
    (see :func:`cond`). Unresolved ``Source`` sentinels (a source absent from
    this feed) are skipped so a comparison never trips over a placeholder.
    """
    lib = _lib()
    values: dict[str, Any] = {}
    if lib is None:
        return values
    for name in _BAR_NAMES:
        try:
            value = _resolve(getattr(lib, name))
        except Exception:
            continue
        if _is_source_sentinel(value):
            continue
        values[name] = value
    return values


# Distinct conditions already logged as unevaluable, so a broken condition logs
# once instead of once per bar it is checked on.
_logged_cond_errors: set[str] = set()


def cond(expr: str, frame_globals: dict[str, Any], frame_locals: dict[str, Any]) -> bool:
    """Evaluate a conditional-breakpoint expression with Pine builtins live.

    The ``ImportNormalizer`` transform rewrites every bare ``bar_index`` /
    ``close`` / ... to ``lib.<name>`` and strips the import, so a natural
    condition like ``bar_index == 10`` is a ``NameError`` at runtime — which
    pydevd surfaces by STOPPING on every bar (``handle_breakpoint_condition``
    returns ``True`` on any condition exception). The proxy wraps each user
    condition in a call to this helper, which evaluates the ORIGINAL expression
    in a namespace where:

    * the bar builtins hold the CURRENT bar's live values (fresh every call,
      read off ``pynecore.lib`` — overriding any stale copy ``bind_sources``
      left in the module globals),
    * ``lib`` and ``pynecore`` are reachable, so ``lib.bar_index`` and the
      fully-qualified ``pynecore.lib.bar_index`` work as well as the bare name,
    * the frame's real locals and the module globals still resolve and shadow
      the builtins (a genuine local ``close`` wins, matching Python scoping).

    An unevaluable condition returns ``False`` (do NOT stop) instead of pydevd's
    stop-on-every-bar, with a one-time log so a real typo is still visible.

    :param expr: The user's original condition text.
    :param frame_globals: The stopped frame's ``globals()``.
    :param frame_locals: The stopped frame's ``locals()``.
    :return: Whether the breakpoint should suspend on this bar.
    """
    namespace: dict[str, Any] = dict(frame_globals)
    namespace.update(_bar_values())
    lib = _lib()
    if lib is not None:
        namespace["lib"] = lib
        try:
            namespace["pynecore"] = importlib.import_module("pynecore")
        except Exception:
            pass
    namespace.update(frame_locals)
    _bind_demangled(namespace)
    try:
        return bool(eval(expr, namespace, namespace))  # noqa: S307
    except Exception as exc:
        if expr not in _logged_cond_errors:
            _logged_cond_errors.add(expr)
            print(f"[pyne debug] conditional breakpoint condition {expr!r} could not be "
                  f"evaluated ({type(exc).__name__}: {exc}); treating as False",
                  file=sys.stderr)
        return False


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


def _owner_of(param: str, frame_name: str) -> str:
    """Which function's state a hidden parameter carries.

    The default param name (``__state__``) belongs to the frame's own
    function; a scope-qualified name (``__state·main__``) is a closure
    reference to that function's state.
    """
    if param == "__state__":
        return frame_name
    return param[len(_STATE_PREFIX):-2]


def _layout_of(state: list) -> dict[str, Any] | None:
    """The slot layout a state vector carries after its last slot, or None.

    ``instance_state._make_state`` appends the scope's layout dict to every
    vector it builds: emitted code addresses literal non-negative indexes only,
    so the extra element is invisible to the script and makes the vector
    self-describing. Reading it is what identifies a hidden ``__state__`` local,
    and the length check doubles as the "is this really a state vector" test.
    """
    if not state or not isinstance(state[-1], dict):
        return None
    layout = state[-1]
    init = layout.get("init")
    if not isinstance(init, (tuple, list)) or len(init) != len(state) - 1:
        return None
    return layout


def _series_slots(layout: dict[str, Any]) -> set[int]:
    """Slot indices of the series slots of one scope layout.

    Only the leading index is read: a ``series`` entry grew a third element
    (``series_elem``) next to ``max_bars_back`` in pynecore 6.6.1, and the tail
    may grow again — positional unpacking would break on every such change.
    """
    return {entry[0] for entry in layout.get("series", ())}


def _is_internal_slot_name(name: str) -> bool:
    """True for a slot name that is compiler plumbing, not a source variable.

    ``__lib·close`` is the hidden history buffer a builtin source grows when the
    script reads ``close[1]`` (see ``lib_series.py``) — its live value already
    shows in the Pyne scope, so listing the buffer as a Locals entry is noise.
    ``p·flag`` is the lazy-init companion of a persistent variable (see
    ``slot_layout.py``): the base slot holds the value.
    """
    return name.startswith("__lib·") or name.endswith("·flag")


def pine_slots(frame_locals: dict[str, Any], frame_name: str) -> str:
    """List the named Pine state slots reachable from a stopped frame.

    :param frame_locals: The frame's ``locals()`` (pydevd evaluate context).
    :param frame_name: The frame's function name (from the DAP stack trace).
    :return: base64 of ``[{name, param, slot, kind, type, owner, own}]``.
    """
    slots: list[dict[str, Any]] = []
    for param, state in frame_locals.items():
        is_qualified = param.startswith(_STATE_PREFIX) and param.endswith("__")
        if param != "__state__" and not is_qualified:
            continue
        if not isinstance(state, list):
            continue
        layout = _layout_of(state)
        if layout is None:
            continue
        owner = _owner_of(param, frame_name)
        names = layout.get("names") or ()
        series_slots = _series_slots(layout)
        child_slots = {entry[0] for entry in layout.get("children", ())}
        seen: set[str] = set()
        for i in range(len(layout["init"])):
            name = names[i] if i < len(names) else None
            # A name repeating after its first slot is a companion slot
            # (lazy-init flag, kahan sum); the first slot holds the value.
            if not name or i in child_slots or name in seen or _is_internal_slot_name(name):
                continue
            seen.add(name)
            is_series = i in series_slots
            slots.append({
                "name": name,
                "param": param,
                "slot": i,
                "kind": "series" if is_series else "var",
                "type": _slot_type_label(state[i], is_series),
                "owner": owner,
                "own": owner == frame_name,
            })
    return base64.b64encode(json.dumps(slots).encode("utf-8")).decode("ascii")


def _collect_state(frame_locals: dict[str, Any], ns: dict[str, Any],
                   series: dict[str, Any]) -> None:
    """Bind a frame's named Pine state into a watch-evaluation namespace.

    Walks the same hidden ``__state__`` vectors as :func:`pine_slots`, but keeps
    the live runtime objects instead of a rendered listing:

    * a series slot's ``SeriesImpl`` is put in ``series`` under its source name,
      so a subscript like ``basis[5]`` can be redirected onto the buffer (the
      frame's ``basis`` local is only the current scalar). Builtin-source history
      buffers (``__lib·close``) are bound under the bare source name (``close``)
      so ``close[1]`` resolves too;
    * a persistent variable's current scalar is bound by name into ``ns`` — the
      transform stores it in ``__state__[N]``, not a local, so a bare ``p`` in a
      watch would otherwise be a ``NameError``.

    Own-scope state wins over closure state of the same name (``setdefault``).
    """
    for param, state in frame_locals.items():
        is_qualified = param.startswith(_STATE_PREFIX) and param.endswith("__")
        if param != "__state__" and not is_qualified:
            continue
        if not isinstance(state, list):
            continue
        layout = _layout_of(state)
        if layout is None:
            continue
        names = layout.get("names") or ()
        series_slots = _series_slots(layout)
        for i in range(len(layout["init"])):
            name = names[i] if i < len(names) else None
            if not name:
                continue
            if i in series_slots:
                if name.startswith("__lib·"):
                    series.setdefault(name[len("__lib·"):], state[i])
                else:
                    series.setdefault(name, state[i])
                    base = _demangle(name)
                    if base:
                        # A renamed series binds under its Pine name too, so a
                        # watch subscript written in Pine terms hits the buffer.
                        series.setdefault(base, state[i])
            elif "·" not in name and not name.startswith("__"):
                # A persistent variable's current scalar (var slot); companion
                # flag slots and children carry the middle dot, so they never
                # bind a bare name.
                ns.setdefault(name, state[i])
                base = _demangle(name)
                if base:
                    ns.setdefault(base, state[i])


class _SeriesSubscript(ast.NodeTransformer):
    """Redirect ``name[...]`` onto the frame's series buffer for ``name``.

    A bare ``basis`` is left alone (it resolves to the current scalar, matching
    Pine's ``basis`` == ``basis[0]``); only a subscript is rewritten to index the
    ``SeriesImpl`` history. Each buffer is injected under a fresh ``__pyne_series_N__``
    global so the compiled expression stays a plain subscript pydevd renders with
    full detail (type + expandable children via the pydevd series plugin).
    """

    def __init__(self, series: dict[str, Any], ns: dict[str, Any]) -> None:
        self._series = series
        self._ns = ns
        self._count = 0

    def visit_Subscript(self, node: ast.Subscript) -> ast.AST:
        self.generic_visit(node)
        value = node.value
        if isinstance(value, ast.Name) and value.id in self._series:
            key = f"__pyne_series_{self._count}__"
            self._count += 1
            self._ns[key] = self._series[value.id]
            node.value = ast.copy_location(ast.Name(id=key, ctx=ast.Load()), value)
        return node


def watch(expr: str, frame_globals: dict[str, Any],
          frame_locals: dict[str, Any]) -> Any:
    """Evaluate a watch/hover expression with Pine series and state resolved.

    The proxy wraps every watch/hover expression in a call to this so the
    developer can type Pine-natural expressions the transformed runtime would
    otherwise reject:

    * ``basis[5]`` / ``close[1]`` — historical series access. In the runtime a
      series variable's own name holds only the current scalar (a plain float,
      not subscriptable); the history lives in an anonymous state slot. This
      rewrites each ``series[...]`` onto that slot's ``SeriesImpl``.
    * ``p`` — a persistent variable, stored in ``__state__[N]`` rather than a
      local, is bound by name to its current value.

    Bare builtins (``close``, ``bar_index``, ``time``) resolve as before (bound
    live off ``pynecore.lib``). The result object is RETURNED as-is so pydevd
    renders it with full type/expansion detail; a genuine error in the user's
    expression propagates so the watch shows it, exactly as an unwrapped watch
    would.

    :param expr: The user's original watch expression.
    :param frame_globals: The stopped frame's ``globals()``.
    :param frame_locals: The stopped frame's ``locals()``.
    :return: The evaluated value.
    """
    ns: dict[str, Any] = dict(frame_globals)
    ns.update(_bar_values())
    lib = _lib()
    if lib is not None:
        ns["lib"] = lib
        try:
            ns["pynecore"] = importlib.import_module("pynecore")
        except Exception:
            pass
    series: dict[str, Any] = {}
    try:
        _collect_state(frame_locals, ns, series)
    except Exception:
        series = {}
    # Real locals resolve last so a genuine local shadows a bound builtin/state,
    # matching Python scoping (and the transform's own name resolution).
    ns.update(frame_locals)
    _bind_demangled(ns)
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError:
        return eval(expr, ns, ns)  # noqa: S307 — surface the real error
    if series:
        _SeriesSubscript(series, ns).visit(tree)
        ast.fix_missing_locations(tree)
    return eval(compile(tree, "<pyne-watch>", "eval"), ns, ns)  # noqa: S307
