"""Pyne Edge profile definition (F8) — hand-maintained, versioned.

The Pyne Edge profile is a strict, Pine-compatible subset of Python: a DSL
whose scripts are guaranteed to run on constrained runtimes (the web/WASM
executor, a possible future static compiler) in addition to normal
CPython/pynecore. The linter is FAIL-CLOSED: anything this module does not
explicitly allow is an error. Loosening or tightening anything here is a
profile revision — bump ``EDGE_RULES_VERSION``.

Ground truth for the allowed set is what the pynecomp emitter can produce.
An AST census over the 140 compiled corpus scripts (2026-07) showed the
emitter uses: imports of ``pynecore.*`` + ``from dataclasses import field`` +
``import lib.*`` only; zero Python builtin calls; no list/dict/set literals,
comprehensions, f-strings, try/with/raise/assert, slices, walrus, yield,
async, global/nonlocal or starred expressions; decorators only
``@script.indicator/strategy/library(...)``, ``@method`` and ``@udt``;
classes only as bases-less ``@udt`` field lists; ``lambda`` only as a
``field(default_factory=lambda: ...)`` UDT field default; plain positional
parameters (with defaults) only; subscripts in Load context only. A few
trivially portable extras are allowed on top and marked below.

Library emission (pynecomp v6.0.46+, ``@script.library``) additionally
produces: ``from typing import Protocol, Any``, a module-level
``__all__ = [...]`` string list, per-export ``class _Protocol...(Protocol)``
signature shims (ellipsis-body ``__call__`` only), ``name: _Protocol... =
Exported()`` assignments, and ``@export`` on nested defs. All static-typing
scaffolding, erased or trivial at runtime — allowed as narrow special cases
(see the worker's ``_EdgeChecker``), not as general syntax.

Additional source material (provenance only, no dependency):
``PyneSys/work/edge-python-pynecore-requirements.md`` and
``PyneSys/work/pynecore-wasm-feature-audit.md``.

Data only, stdlib only — imported by ``pyneide_series.py`` next to it.
"""

EDGE_RULES_VERSION = '2026.07.1'

# --- syntax ----------------------------------------------------------------

# Allowed positioned AST node types; any other statement/expression node is a
# `pyne-edge-syntax` error. Helper nodes without their own position
# (`arguments`, `comprehension`, `withitem`, ...) are governed by their
# parents. Operators and expression contexts are checked separately below.
ALLOWED_NODES = frozenset({
    'Module', 'FunctionDef', 'ClassDef', 'arg', 'keyword', 'alias',
    'Import', 'ImportFrom',
    'Assign', 'AnnAssign', 'AugAssign', 'Expr', 'Return', 'Pass',
    'If', 'IfExp', 'For', 'While', 'Break', 'Continue',
    'BinOp', 'BoolOp', 'UnaryOp', 'Compare',
    'Call', 'Attribute', 'Subscript', 'Name', 'Constant', 'Tuple', 'Lambda',
})

# The emitter uses Add/Sub/Mult/Div/Mod only; FloorDiv (Pine integer
# division), Pow and UAdd are trivially portable arithmetic and allowed on
# top. Bitwise/shift/matmul operators and is/in comparisons are out.
ALLOWED_BIN_OPS = frozenset({'Add', 'Sub', 'Mult', 'Div', 'FloorDiv', 'Mod', 'Pow'})
ALLOWED_UNARY_OPS = frozenset({'USub', 'UAdd', 'Not'})
ALLOWED_BOOL_OPS = frozenset({'And', 'Or'})
ALLOWED_CMP_OPS = frozenset({'Eq', 'NotEq', 'Lt', 'LtE', 'Gt', 'GtE'})

# --- imports ---------------------------------------------------------------

# Top-level module prefixes importable without restriction: the PyneCore API
# and workdir/community libraries (`workdir/scripts/lib`, e.g.
# `import lib.TradingView.ta.v8` — the emitter produces these itself).
ALLOWED_IMPORT_PREFIXES = ('pynecore', 'lib')

# Other `from <module> import <name>` sources: module -> allowed names.
# No stdlib beyond these — Pine's math/str/... live under `pynecore.lib`.
ALLOWED_FROM_MODULES = {
    'dataclasses': frozenset({'dataclass', 'field'}),
    '__future__': frozenset({'annotations'}),  # lexical only, changes nothing
    # Static-typing-only names the pynecomp library emitter uses for its
    # export shims (`class _Protocol...(Protocol)` + `-> Any`); erased at
    # runtime, trivially portable.
    'typing': frozenset({'Protocol', 'Any'}),
}

# --- decorators ------------------------------------------------------------

# Functions are not objects in the Edge profile, so only these built-in
# decorators exist. Bare-name decorators are validated against the module
# they were imported from; `@script.<name>(...)` must be a *called*
# `pynecore.lib.script` chain (SCRIPT_DECORATORS in the worker).
ALLOWED_FUNC_DECORATORS = frozenset({
    ('pynecore.core.pine_method', 'method'),
    # Library exports (`@export def myFunction(...)` inside `main()`).
    ('pynecore.core.pine_export', 'export'),
})
ALLOWED_CLASS_DECORATORS = frozenset({
    ('pynecore.core.pine_udt', 'udt'),
    ('dataclasses', 'dataclass'),
})

# --- calls -----------------------------------------------------------------

# Python builtins callable in Edge code. The emitter itself calls none; this
# hand-curated minimum for hand-written scripts is limited to builtins every
# constrained runtime supports trivially. Notably absent (and therefore
# errors): exec/eval/compile/__import__, getattr/setattr/hasattr/delattr,
# type/isinstance, open, globals/locals/vars.
ALLOWED_BUILTIN_CALLS = frozenset({
    'len', 'abs', 'min', 'max', 'round', 'int', 'float', 'bool', 'str',
    'range', 'enumerate', 'print',
})
