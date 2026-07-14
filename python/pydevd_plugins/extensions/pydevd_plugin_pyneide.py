"""Readable Variables-panel presentation for PyneCore series buffers.

pydevd (vendored inside debugpy) loads every ``pydevd_plugin*`` module it
finds in the ``pydevd_plugins.extensions`` namespace package across sys.path.
The extension's ``python/`` directory is on PYTHONPATH in every bridge
process, so Pyne debug sessions pick this up automatically — no install step.

A transformed script keeps the current scalar value in the variable's own
name (``s = __state__[N].add(...)``), so plain locals already read fine; this
plugin makes the underlying ``SeriesImpl`` circular buffers legible when the
user expands ``__state__`` or a series-typed value: the summary shows the
newest values in Pine index order, the children expose per-offset history.
"""

from _pydevd_bundle.pydevd_extension_api import (  # noqa: F401 (pydevd provides this)
    StrPresentationProvider,
    TypeResolveProvider,
)

_STR_VALUES = 3
_CHILD_VALUES = 30


def _child_evaluate_name(i):
    return lambda parent: f"{parent}[{i}]"


def _is_series(type_object, _type_name) -> bool:
    return (
        getattr(type_object, "__name__", None) == "SeriesImpl"
        and getattr(type_object, "__module__", None) == "pynecore.core.series"
    )


def _is_na(value) -> bool:
    t = type(value)
    return (
        getattr(t, "__name__", None) == "NA"
        and getattr(t, "__module__", None) == "pynecore.types.na"
    )


def _fmt(value) -> str:
    if _is_na(value):
        return "na"
    if isinstance(value, float):
        return f"{value:g}"
    return repr(value)


class PyneSeriesStr(StrPresentationProvider):
    """``Series([0]=1.5, [1]=1.4, [2]=1.3, …, len=520)`` summaries."""

    def can_provide(self, type_object, type_name):
        return _is_series(type_object, type_name)

    def get_str(self, val):
        try:
            size = len(val)
            parts = [f"[{i}]={_fmt(val[i])}" for i in range(min(size, _STR_VALUES))]
            if size > _STR_VALUES:
                parts.append("…")
            parts.append(f"len={size}")
            return f"Series({', '.join(parts)})"
        except Exception:
            return object.__repr__(val)


class PyneSeriesResolver(TypeResolveProvider):
    """Expandable children: per-offset history (Pine order) + buffer facts."""

    def can_provide(self, type_object, type_name):
        return _is_series(type_object, type_name)

    def get_contents_debug_adapter_protocol(self, var, fmt=None):
        """Children in Pine history order, ``[0]`` (newest) first.

        pydevd's fallback path sorts ``get_dictionary`` keys lexicographically,
        which interleaves ``[10]`` between ``[1]`` and ``[2]``; when the
        resolver provides this method the given order is kept verbatim. The
        third tuple element builds each child's evaluate name off the parent's
        (``smooth`` -> ``smooth[3]``), so watch/copy work on history entries.
        """
        entries = []
        try:
            size = len(var)
            for i in range(min(size, _CHILD_VALUES)):
                entries.append((f"[{i}]", var[i], _child_evaluate_name(i)))
            if size > _CHILD_VALUES:
                entries.append(("…", f"{size - _CHILD_VALUES} older bars not shown", None))
            entries.append(("len", size, None))
            entries.append(("max_bars_back", var.max_bars_back, None))
        except Exception as exc:
            entries.append(("<error>", str(exc), None))
        return entries

    def get_dictionary(self, var):
        out = {}
        try:
            size = len(var)
            for i in range(min(size, _CHILD_VALUES)):
                out[f"[{i}]"] = var[i]
            if size > _CHILD_VALUES:
                out["…"] = f"{size - _CHILD_VALUES} older bars not shown"
            out["len"] = size
            out["max_bars_back"] = var.max_bars_back
        except Exception as exc:
            out["<error>"] = str(exc)
        return out

    def resolve(self, var, attribute):
        if attribute.startswith("[") and attribute.endswith("]"):
            try:
                return var[int(attribute[1:-1])]
            except (ValueError, TypeError):
                return None
        if attribute == "len":
            return len(var)
        if attribute == "max_bars_back":
            return var.max_bars_back
        return None
