"""Frame introspection for the IDE-side debug adapter proxy.

At runtime the transform stores Pine persistent/series variables in anonymous
``__state__[N]`` slots; the source names survive only in the transform layout
(the module's ``__pyne_slot_layout__`` dict, ``names`` tuple). The proxy
evaluates :func:`pine_slots` inside the stopped frame (pydevd ``evaluate``)
and injects the named variables into the Locals scope.

Everything here must be side-effect free: it runs against a live, suspended
script. The result is base64-encoded JSON, because the evaluate response
carries ``repr(str)`` and base64 keeps that trivially parseable.
"""

from __future__ import annotations

import base64
import importlib
import json
from typing import Any

_STATE_PREFIX = "__state·"  # scope-qualified hidden param: __state·main__

# The current bar's essence, read straight off ``pynecore.lib`` (the runner
# sets these per bar as plain scalars). ``bar_index`` leads because "which bar
# am I on" is the first question at a breakpoint.
_CONTEXT_NAMES = ("bar_index", "open", "high", "low", "close", "volume")


def _fmt(value: Any) -> str:
    try:
        return repr(value)
    except Exception:  # a __repr__ that raises must not break inspection
        return "<unrepr>"


def _bar_context() -> list[dict[str, Any]]:
    """Current bar_index + OHLCV from the live ``pynecore.lib`` module."""
    try:
        lib = importlib.import_module("pynecore.lib")
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for name in _CONTEXT_NAMES:
        try:
            value = getattr(lib, name)
        except Exception:
            continue
        out.append({"name": name, "value": _fmt(value), "type": type(value).__name__})
    return out


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
    :return: base64 of ``{"context": [{name, value, type}],
             "slots": [{name, param, slot, kind, owner, own}]}``.
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
    payload = json.dumps({"context": _bar_context(), "slots": slots})
    return base64.b64encode(payload.encode("utf-8")).decode("ascii")
