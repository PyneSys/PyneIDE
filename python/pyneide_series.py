"""Series-access analyzer for the IDE's pyright diagnostic filter (F7/L5c).

The `Series[T] = T` stub alias makes the scalar side of Pyne perfectly
type-correct at the cost of history indexing: pyright sees `close[1]` as
`float[1]` and reports `reportIndexIssue`. L5b suppressed the whole rule in
`@pyne` files; this module lets the IDE suppress only the accesses pynecomp
actually rewrites into series-buffer reads, so genuine index errors survive.

What counts as a series access mirrors the compiler's own transformers
(`pynecore.transformers.{import_normalizer,lib_series,series}`), NOT Pine
semantics — the goal is "would pynecomp turn this into a buffer read?", and
whether that read is *meaningful* is the Pyne-checker's job (L5d):

- a bare name declared `Series[T]` / `PersistentSeries[T]` in this scope or an
  enclosing one (`SeriesTransformer._lookup`), including such parameters,
- a bare name imported from `pynecore.lib` — the import normalizer rewrites it
  to `lib.<name>`, which `LibrarySeriesTransformer` then anchors as a series,
- an attribute chain rooted at the `lib` module.

Everything else — parenthesized expressions, call results, plain locals,
`Persistent[T]` (no buffer) — is a real error at runtime too.

Two deliberate faithfulness quirks, both matching pynecomp:

- a plain local assignment does NOT shadow a lib import (the normalizer only
  spares function parameters), but a parameter does,
- every lib symbol is treated as indexable except `NON_SERIES_LIB_ATTRS`,
  because `LibrarySeriesTransformer` does not check what it wraps either.

Beyond the filter data, the same pass runs the Pyne-checker (L5d): script-
structure rules mirroring the errors pynecore itself raises at compile/import
time, so they show up while editing instead of on the first run. Every rule is
conservative — when a construct cannot be resolved statically (an unknown
decorator, an aliased call) the rule stays silent, because a missed error
surfaces at run time anyway but a false one poisons the whole panel.

Protocol: NDJSON on stdin/stdout, one request/response object per line.
Request  ``{"id": N, "source": "..."}``
Response ``{"id": N, "ok": true, "spans": [[line, col, endCol], ...],
            "refs": [[line, col, endCol, "Series[float]"], ...],
            "problems": [[line, col, endCol, "code", "message"], ...]}``
         ``{"id": N, "ok": false, "error": "..."}`` on unparsable source.

Positions are 0-based LSP coordinates: `line` is 0-based and columns are
UTF-16 code units, converted from ast's UTF-8 byte offsets. Spans never
cross a line (an indexed base that wraps lines is reported as unmatchable,
so its diagnostic is simply kept).

Stdlib only, no pynecore import: the analyzer has to work before the managed
environment is bootstrapped, on whatever Python 3 the IDE can find.
"""

from __future__ import annotations

import ast
import json
import sys
from typing import Any, Iterable

# Kept in sync with pynecore.transformers.lib_series.NON_SERIES_LIB_ATTRS.
NON_SERIES_LIB_ATTRS = frozenset({'extra_fields'})

SERIES_ANNOTATIONS = frozenset({'Series', 'PersistentSeries'})

# Persistent flavors (pynecore.transformers.persistent.PERSISTENT_TYPES);
# PersistentSeries rewrites into a Series declaration, so it follows the
# Series-scope rule instead.
PERSISTENT_ANNOTATIONS = frozenset({'Persistent', 'IBPersistent', 'IBPersistentSeries'})

SCRIPT_DECORATORS = frozenset({'indicator', 'strategy', 'library'})

# Kept in sync with pynecore.transformers.security._FORBIDDEN_STRATEGY_STATE_ATTRS.
FORBIDDEN_STRATEGY_STATE_ATTRS = frozenset({
    'equity', 'eventrades', 'grossloss', 'grossprofit', 'initial_capital',
    'losstrades', 'max_drawdown', 'max_runup', 'netprofit', 'openprofit',
    'position_avg_price', 'position_size', 'wintrades',
})

# request.<fn> whose expression argument runs in a security child context;
# the value is the expression's positional index in the call.
SECURITY_EXPRESSION_ARG = {'security': 2, 'security_lower_tf': 2}


class _Utf16Columns:
    """Convert ast's UTF-8 byte column offsets to UTF-16 LSP characters."""

    def __init__(self, source: str):
        self._lines = [line.encode('utf-8') for line in source.splitlines()]

    def convert(self, line: int, byte_col: int) -> int:
        if line < 0 or line >= len(self._lines):
            return byte_col
        raw = self._lines[line]
        if byte_col <= 0:
            return 0
        prefix = raw[:byte_col].decode('utf-8', errors='replace')
        # ASCII is the overwhelmingly common case; skip the per-char scan.
        if prefix.isascii():
            return len(prefix)
        return sum(2 if ord(ch) > 0xFFFF else 1 for ch in prefix)

    def line_end(self, line: int) -> int:
        if line < 0 or line >= len(self._lines):
            return 0
        return self.convert(line, len(self._lines[line]))


class _Scope:
    """One function nesting level's name bindings."""

    def __init__(self, parent: '_Scope | None'):
        self.parent = parent
        self.series: dict[str, str] = {}  # name -> rendered annotation
        # Every Pyne-typed declaration (series AND persistent) for hover refs;
        # persistent names are not indexable, so they stay out of `series`.
        self.annotations: dict[str, str] = {}
        self.params: set[str] = set()
        self.locals: set[str] = set()

    def lookup_series(self, name: str) -> str | None:
        """Resolve a name to its series annotation through the scope chain.

        Mirrors ``SeriesTransformer._lookup``: a name bound locally in this
        scope without a series declaration here shadows a parent's series.
        """
        if name in self.series:
            return self.series[name]
        if name in self.locals or name in self.params:
            return None
        return self.parent.lookup_series(name) if self.parent else None

    def lookup_annotation(self, name: str) -> str | None:
        """Like ``lookup_series``, over all Pyne-typed declarations."""
        if name in self.annotations:
            return self.annotations[name]
        if name in self.locals or name in self.params:
            return None
        return self.parent.lookup_annotation(name) if self.parent else None

    def shadows_lib(self, name: str) -> bool:
        """Whether `name` is a parameter here or in an enclosing scope.

        Only parameters shadow a lib import — the import normalizer rewrites
        every other `Load` of an imported name, local assignment or not.
        """
        scope: _Scope | None = self
        while scope is not None:
            if name in scope.params:
                return True
            scope = scope.parent
        return False


def _annotation_name(annotation: ast.expr) -> str | None:
    """The bare name of a (possibly subscripted) annotation, or None."""
    if isinstance(annotation, ast.Subscript):
        annotation = annotation.value
    return annotation.id if isinstance(annotation, ast.Name) else None


def _render_annotation(annotation: ast.expr) -> str:
    try:
        return ast.unparse(annotation)
    except Exception:  # pragma: no cover - unparse is total in practice
        return _annotation_name(annotation) or 'Series'


def _function_defs(body: Iterable[ast.stmt]) -> Iterable[ast.stmt]:
    return (stmt for stmt in body
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)))


class _LibImports:
    """Names the import normalizer would rewrite into `lib.<chain>` accesses."""

    def __init__(self, tree: ast.Module):
        self.names: dict[str, list[str]] = {}
        self.modules: set[str] = {'lib'}
        # Function-level lib imports are lifted to module level by
        # ImportLifterTransformer, so the whole tree is one import namespace.
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                self._from_import(node)
            elif isinstance(node, ast.Import):
                self._import(node)

    def _from_import(self, node: ast.ImportFrom) -> None:
        module = node.module or ''
        if module == 'pynecore':
            for alias in node.names:
                if alias.name == 'lib':
                    self.modules.add(alias.asname or 'lib')
            return
        if module != 'pynecore.lib' and not module.startswith('pynecore.lib.'):
            return
        prefix = module.split('.')[2:]
        for alias in node.names:
            if alias.name == '*':
                # Wildcards need the module's __all__, which is only knowable
                # by importing pynecore. Unresolvable names then fall through
                # to "not a series", so their diagnostics are kept.
                continue
            self.names[alias.asname or alias.name] = prefix + [alias.name]

    def _import(self, node: ast.Import) -> None:
        for alias in node.names:
            if alias.name != 'pynecore.lib' and not alias.name.startswith('pynecore.lib.'):
                continue
            parts = alias.name.split('.')[2:]
            self.modules.add(alias.asname or (parts[-1] if parts else 'lib'))

    def is_series_name(self, name: str) -> bool:
        chain = self.names.get(name)
        return chain is not None and chain[0] not in NON_SERIES_LIB_ATTRS

    def chain(self, root: str, attrs: list[str]) -> list[str] | None:
        """Normalize `root.<attrs>` to its `lib.*` attribute chain, or None.

        The root is either a lib module alias (`lib.syminfo.x`) or a name
        imported from the lib (`from pynecore.lib import syminfo` — the
        normalizer expands it back to the same `lib.syminfo.x` chain).
        """
        if root in self.modules:
            return attrs
        if root in self.names:
            return self.names[root] + attrs
        return None

    def is_series_chain(self, root: str, attrs: list[str]) -> bool:
        """Whether `root.<attrs>` normalizes to a `lib.*` series access."""
        chain = self.chain(root, attrs)
        return bool(chain) and chain[0] not in NON_SERIES_LIB_ATTRS


class _Analyzer(ast.NodeVisitor):
    """Collects legitimate series-subscript bases and series name references."""

    def __init__(self, tree: ast.Module, columns: _Utf16Columns):
        self.columns = columns
        self.lib = _LibImports(tree)
        self.spans: list[tuple[int, int, int]] = []
        self.refs: list[tuple[int, int, int, str]] = []
        self.problems: list[tuple[int, int, int, str, str]] = []
        self.scope = _Scope(None)
        self._collect_bindings(tree.body, self.scope)

    # --- binding pre-pass ------------------------------------------------

    def _collect_bindings(self, body: Iterable[ast.stmt], scope: _Scope) -> None:
        """Record a scope's own bindings before visiting its statements.

        The compiler registers series slots as it walks, so a read placed
        above its declaration would not resolve there. Collecting up front is
        deliberately more permissive: it keeps the filter stable while a
        declaration is still being typed, and "declared below" is a Pyne-checker
        concern (L5d), not something worth a transient false error here.
        """
        for stmt in _walk_scope(body):
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                name = _annotation_name(stmt.annotation)
                if name in SERIES_ANNOTATIONS:
                    scope.series[stmt.target.id] = _render_annotation(stmt.annotation)
                    scope.annotations[stmt.target.id] = _render_annotation(stmt.annotation)
                elif name in PERSISTENT_ANNOTATIONS:
                    # Persistent has no history buffer — a hover ref, never an
                    # indexable series base.
                    scope.annotations[stmt.target.id] = _render_annotation(stmt.annotation)
                    scope.locals.add(stmt.target.id)
                else:
                    scope.locals.add(stmt.target.id)
            elif isinstance(stmt, ast.Assign):
                for target in stmt.targets:
                    for name in _bound_names(target):
                        scope.locals.add(name)
            elif isinstance(stmt, (ast.For, ast.AsyncFor)):
                for name in _bound_names(stmt.target):
                    scope.locals.add(name)
            elif isinstance(stmt, ast.AugAssign):
                for name in _bound_names(stmt.target):
                    scope.locals.add(name)

    # --- visitors --------------------------------------------------------

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_function(node)

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)

        scope = _Scope(self.scope)
        args = node.args
        for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs]:
            scope.params.add(arg.arg)
            if arg.annotation is None:
                continue
            name = _annotation_name(arg.annotation)
            if name in SERIES_ANNOTATIONS:
                scope.series[arg.arg] = _render_annotation(arg.annotation)
                scope.annotations[arg.arg] = _render_annotation(arg.annotation)
            elif name in PERSISTENT_ANNOTATIONS:
                scope.annotations[arg.arg] = _render_annotation(arg.annotation)
        if args.vararg:
            scope.params.add(args.vararg.arg)
        if args.kwarg:
            scope.params.add(args.kwarg.arg)
        self._collect_bindings(node.body, scope)

        outer, self.scope = self.scope, scope
        try:
            for stmt in node.body:
                self.visit(stmt)
        finally:
            self.scope = outer

    def visit_Name(self, node: ast.Name) -> None:
        # Store contexts are hover targets too (`p += 1`, re-assignments, the
        # declaration itself), and pyright's literal narrowing makes exactly
        # those hovers the most misleading — so every occurrence is a ref.
        annotation = self.scope.lookup_annotation(node.id)
        if annotation is not None:
            span = self._span(node)
            if span is not None:
                self.refs.append((*span, annotation))

    def visit_Subscript(self, node: ast.Subscript) -> None:
        if self._is_series_base(node.value):
            span = self._span(node.value)
            if span is not None:
                self.spans.append(span)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        """Pyne-checker: strategy state inside a request.security expression.

        Mirrors `SecurityTransformer._find_forbidden_strategy_state`: the
        expression runs in the security child process, where strategy state
        does not exist — pynecomp rejects it with a SyntaxError at compile
        time. Only direct `strategy.<attr>` chains are detected, exactly like
        the compiler; local aliases fail safe at runtime instead.
        """
        chain = self._lib_chain(node.func)
        if (chain is not None and len(chain) == 2 and chain[0] == 'request'
                and chain[1] in SECURITY_EXPRESSION_ARG):
            expression = self._call_arg(node, SECURITY_EXPRESSION_ARG[chain[1]], 'expression')
            if expression is not None:
                for bad, attr in self._forbidden_strategy_state(expression):
                    self.problems.append((
                        *_node_span(self.columns, bad), 'pyne-security-strategy-state',
                        f"'strategy.{attr}' cannot be used as the expression "
                        f"argument of request.{chain[1]}() — strategy state is "
                        f"only available in the chart context, not in a "
                        f"security context"))
        self.generic_visit(node)

    def _lib_chain(self, expr: ast.expr) -> list[str] | None:
        """The `lib.*` chain `expr` normalizes to, honoring parameter shadowing."""
        root = _expr_root(expr)
        if root is None or self.scope.shadows_lib(root):
            return None
        return _lib_chain_of(expr, self.lib)

    @staticmethod
    def _call_arg(node: ast.Call, index: int, keyword: str) -> ast.expr | None:
        for kw in node.keywords:
            if kw.arg == keyword:
                return kw.value
        if index < len(node.args):
            arg = node.args[index]
            return None if isinstance(arg, ast.Starred) else arg
        return None

    def _forbidden_strategy_state(self, expr: ast.expr) -> 'Iterable[tuple[ast.expr, str]]':
        for sub in ast.walk(expr):
            if isinstance(sub, ast.Attribute) and sub.attr in FORBIDDEN_STRATEGY_STATE_ATTRS:
                chain = self._lib_chain(sub)
                if chain is not None and chain[:-1] == ['strategy']:
                    yield sub, sub.attr
            elif isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Load):
                chain = self._lib_chain(sub)
                if (chain is not None and len(chain) == 2 and chain[0] == 'strategy'
                        and chain[1] in FORBIDDEN_STRATEGY_STATE_ATTRS):
                    yield sub, chain[1]

    # --- classification --------------------------------------------------

    def _is_series_base(self, base: ast.expr) -> bool:
        if isinstance(base, ast.Name):
            if self.scope.lookup_series(base.id) is not None:
                return True
            return not self.scope.shadows_lib(base.id) and self.lib.is_series_name(base.id)
        if isinstance(base, ast.Attribute):
            chain = _attribute_chain(base)
            if chain is None:
                return False
            root, attrs = chain
            return not self.scope.shadows_lib(root) and self.lib.is_series_chain(root, attrs)
        return False

    def _span(self, node: ast.expr) -> tuple[int, int, int] | None:
        """The node's 0-based LSP span, or None if it spans several lines."""
        if node.end_lineno is None or node.end_lineno != node.lineno:
            return None
        line = node.lineno - 1
        start = self.columns.convert(line, node.col_offset)
        end = self.columns.convert(line, node.end_col_offset or node.col_offset)
        return line, start, end


def _walk_scope(body: Iterable[ast.stmt]) -> Iterable[ast.stmt]:
    """Yield statements of a scope, without descending into nested functions."""
    for stmt in body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        yield stmt
        for field in ('body', 'orelse', 'finalbody'):
            nested = getattr(stmt, field, None)
            if isinstance(nested, list):
                yield from _walk_scope(nested)
        for handler in getattr(stmt, 'handlers', []) or []:
            yield from _walk_scope(handler.body)


def _attribute_chain(node: ast.Attribute) -> tuple[str, list[str]] | None:
    """Split a pure `name.a.b` chain into its root name and attributes.

    Returns None as soon as anything else (a call, a subscript) sits in the
    chain — those never reach `LibrarySeriesTransformer`'s rewrite.
    """
    attrs: list[str] = []
    current: ast.expr = node
    while isinstance(current, ast.Attribute):
        attrs.append(current.attr)
        current = current.value
    if not isinstance(current, ast.Name):
        return None
    attrs.reverse()
    return current.id, attrs


def _expr_root(expr: ast.expr) -> str | None:
    """The root name of a bare name or pure attribute chain, or None."""
    if isinstance(expr, ast.Name):
        return expr.id
    if isinstance(expr, ast.Attribute):
        split = _attribute_chain(expr)
        return split[0] if split is not None else None
    return None


def _lib_chain_of(expr: ast.expr, lib: _LibImports) -> list[str] | None:
    """Normalize a name/attribute expression to its `lib.*` chain, or None."""
    if isinstance(expr, ast.Name):
        return lib.chain(expr.id, [])
    if isinstance(expr, ast.Attribute):
        split = _attribute_chain(expr)
        if split is None:
            return None
        return lib.chain(*split)
    return None


def _node_span(columns: _Utf16Columns, node: ast.AST) -> tuple[int, int, int]:
    """A node's 0-based LSP span; a multi-line node covers its first line."""
    line = getattr(node, 'lineno', 1) - 1
    col = getattr(node, 'col_offset', 0)
    start = columns.convert(line, col)
    if getattr(node, 'end_lineno', None) == line + 1:
        end_col = getattr(node, 'end_col_offset', None)
        if end_col is not None:
            return line, start, columns.convert(line, end_col)
    return line, start, columns.line_end(line)


class _StructureChecker:
    """Script-structure rules mirroring pynecore's own import-time errors (L5d).

    Each rule reproduces a check pynecore/pynecomp performs when the script is
    first imported — the messages match, only the timing moves into the editor:

    - a runnable script must define `main()` (`script_runner`),
    - `main` must be decorated with a *called* `@script.indicator/strategy/
      library(...)` (the runtime checks `hasattr(main, 'script')`),
    - `Series`/`Persistent` declarations only work inside a function
      (`transformers.series` / `transformers.persistent`),
    - `lib` cannot be imported under an alias (`transformers.import_normalizer`).

    A module-level `main` bound any other way (imported, assigned) satisfies
    the runtime `hasattr(module, 'main')` check, so only its absence is
    flagged and the decorator rule stays silent for those bindings. Unknown
    decorators (anything not resolvable to a lib chain) silence the decorator
    rule too — a wrapper could legitimately set `.script`.
    """

    def __init__(self, tree: ast.Module, lib: _LibImports, columns: _Utf16Columns):
        self.tree = tree
        self.lib = lib
        self.columns = columns
        self.problems: list[tuple[int, int, int, str, str]] = []

    def check(self) -> None:
        self._check_lib_alias()
        self._check_module_scope_declarations()
        self._check_main()

    def _check_lib_alias(self) -> None:
        for node in ast.walk(self.tree):
            if not isinstance(node, ast.ImportFrom) or node.module != 'pynecore':
                continue
            for alias in node.names:
                if alias.name == 'lib' and alias.asname:
                    self.problems.append((
                        *_node_span(self.columns, node), 'pyne-lib-alias',
                        "'lib' must be imported as itself, not as an alias"))

    def _check_module_scope_declarations(self) -> None:
        for stmt in _walk_scope(self.tree.body):
            if not (isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name)):
                continue
            name = _annotation_name(stmt.annotation)
            if name in SERIES_ANNOTATIONS:
                self.problems.append((
                    *_node_span(self.columns, stmt), 'pyne-series-scope',
                    'Series variables must be declared inside a function'))
            elif name in PERSISTENT_ANNOTATIONS:
                self.problems.append((
                    *_node_span(self.columns, stmt), 'pyne-persistent-scope',
                    'Persistent variables must be declared inside a function'))

    def _check_main(self) -> None:
        main_def: ast.FunctionDef | ast.AsyncFunctionDef | None = None
        main_bound = False
        for stmt in _walk_scope(self.tree.body):
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                # _walk_scope never yields function defs, but keep the intent
                # explicit if that ever changes.
                continue
            if isinstance(stmt, ast.Assign):
                main_bound |= any('main' in _bound_names(t) for t in stmt.targets)
            elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                main_bound |= stmt.target.id == 'main'
            elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
                main_bound |= any(
                    (alias.asname or alias.name) == 'main' for alias in stmt.names)
        for stmt in self._scope_function_defs(self.tree.body):
            if stmt.name == 'main':
                main_def = stmt
                break
        if main_def is not None:
            self._check_main_decorators(main_def)
        elif not main_bound:
            line_end = self.columns.line_end(0)
            self.problems.append((
                0, 0, line_end, 'pyne-main-missing',
                "Pyne script must have a 'main' function to run"))

    def _scope_function_defs(
        self, body: list[ast.stmt]
    ) -> Iterable[ast.FunctionDef | ast.AsyncFunctionDef]:
        """Module-scope function defs, including conditionally defined ones."""
        for stmt in body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                yield stmt
                continue
            if isinstance(stmt, (ast.ClassDef, ast.Lambda)):
                continue
            for field in ('body', 'orelse', 'finalbody'):
                nested = getattr(stmt, field, None)
                if isinstance(nested, list):
                    yield from self._scope_function_defs(nested)
            for handler in getattr(stmt, 'handlers', []) or []:
                yield from self._scope_function_defs(handler.body)

    def _check_main_decorators(self, fn: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        resolved: list[tuple[list[str], bool, ast.expr]] = []
        for decorator in fn.decorator_list:
            called = isinstance(decorator, ast.Call)
            target = decorator.func if isinstance(decorator, ast.Call) else decorator
            chain = _lib_chain_of(target, self.lib)
            if chain is None:
                return
            resolved.append((chain, called, decorator))
        for chain, called, decorator in resolved:
            if len(chain) == 2 and chain[0] == 'script' and chain[1] in SCRIPT_DECORATORS:
                if called:
                    return
                # Bare `@script.indicator` calls the factory with `main` as its
                # title and never sets `.script` — a subtle runtime breakage.
                self.problems.append((
                    *_node_span(self.columns, decorator), 'pyne-main-undecorated',
                    f"'@script.{chain[1]}' must be applied as a call: "
                    f"'@script.{chain[1]}(...)'"))
                return
        prefix = 'async def ' if isinstance(fn, ast.AsyncFunctionDef) else 'def '
        line = fn.lineno - 1
        start = self.columns.convert(line, fn.col_offset)
        end = self.columns.convert(line, fn.col_offset + len(prefix) + len(fn.name))
        self.problems.append((
            line, start, end, 'pyne-main-undecorated',
            "The 'main' function must be decorated with @script.indicator(...), "
            "@script.strategy(...) or @script.library(...)"))


def _bound_names(target: ast.expr) -> Iterable[str]:
    if isinstance(target, ast.Name):
        yield target.id
    elif isinstance(target, (ast.Tuple, ast.List)):
        for elt in target.elts:
            yield from _bound_names(elt)
    elif isinstance(target, ast.Starred):
        yield from _bound_names(target.value)


def _is_internal_test_module(tree: ast.Module) -> bool:
    """Whether the module is pynecore-internal rather than a user script.

    pynecore's own test suite keeps `@pyne` modules that deliberately break
    the script rules: pytest-plugin test modules (module-level `__test_*__`
    functions) hold undecorated/duplicated `main` bodies as test data, and
    already-transformed AST fixtures bind `__pyne*__` dunders. The checker
    stays entirely silent on those — every finding there would be noise.
    """
    for stmt in tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if stmt.name.startswith('__test_') and stmt.name.endswith('__'):
                return True
        elif isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                for name in _bound_names(target):
                    if name.startswith('__pyne'):
                        return True
    return False


def analyze(source: str) -> dict[str, Any]:
    """Analyze Pyne source: series spans/references plus checker problems."""
    tree = ast.parse(source)
    columns = _Utf16Columns(source)
    analyzer = _Analyzer(tree, columns)
    for stmt in tree.body:
        analyzer.visit(stmt)
    if _is_internal_test_module(tree):
        problems: list[tuple[int, int, int, str, str]] = []
    else:
        checker = _StructureChecker(tree, analyzer.lib, columns)
        checker.check()
        problems = sorted(checker.problems + analyzer.problems)
    return {
        'spans': [list(span) for span in analyzer.spans],
        'refs': [list(ref) for ref in analyzer.refs],
        'problems': [list(problem) for problem in problems],
    }


def main() -> int:
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        request_id = request.get('id')
        try:
            response: dict[str, Any] = {'id': request_id, 'ok': True}
            response.update(analyze(request.get('source') or ''))
        except SyntaxError as exc:
            # Half-typed source: the IDE keeps the previous result or falls
            # back to suppressing the whole rule.
            response = {'id': request_id, 'ok': False, 'error': f'syntax: {exc}'}
        except Exception as exc:
            response = {'id': request_id, 'ok': False, 'error': f'{type(exc).__name__}: {exc}'}
        out.write(json.dumps(response, ensure_ascii=False, separators=(',', ':')) + '\n')
        out.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
