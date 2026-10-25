/**
 * Bundled Pyne-checker smoke test — runs WITHOUT VSCode against the stdlib-only
 * worker in python/pyneide_series.py, driving it exactly like the extension
 * does (NDJSON on stdin/stdout). Verifies the L5d contract: the checker reports
 * the same script-structure and security errors pynecore raises at import time,
 * while leaving the L5c series data (spans/refs) intact and staying silent on
 * every construct it cannot resolve statically.
 *
 * One long-lived worker answers many requests, matched by id. Usage:
 *   node dist/checker-smoke.js
 */
import { Worker, type WorkerResponse } from './checkerWorker';

const log = (msg: string): void => console.log(msg);

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const codesOf = (r: WorkerResponse): string[] => (r.problems ?? []).map((p) => p[3]);
const messagesOf = (r: WorkerResponse): string[] => (r.problems ?? []).map((p) => p[4]);

/** Assert a successful response whose problem codes match `expected` exactly. */
function expectCodes(r: WorkerResponse, expected: string[], label: string): void {
  assert(r.ok, `${label}: worker returned ok:false (${r.error ?? 'no error'})`);
  const got = codesOf(r);
  assert(
    got.length === expected.length && expected.every((c, i) => got[i] === c),
    `${label}: expected codes ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`
  );
}

// Each source is a `@pyne` module; the docstring is what marks it for the IDE.
const HEAD = '"""\n@pyne\n"""\n';

async function main(): Promise<void> {
  const worker = new Worker(20000);
  try {
    // --- valid script: no problems, but the L5c series data survives --------
    const valid = await worker.request(
      HEAD +
        'from pynecore import Series\n' +
        'from pynecore.lib import script, close, ta\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    s: Series[float] = close\n' +
        '    hist = s[1]\n' +
        '    print(hist, ta)\n'
    );
    expectCodes(valid, [], 'valid');
    assert((valid.spans ?? []).length > 0, `valid: expected non-empty spans, got ${JSON.stringify(valid.spans)}`);
    assert((valid.refs ?? []).length > 0, `valid: expected non-empty refs, got ${JSON.stringify(valid.refs)}`);
    log('valid OK');

    const parameterSource = HEAD + `def main(
    rewardRisk: float = 2.0,
    unused: float = 1.0,
    shadowed: float = 0.0,
    captured: float = 3.0,
    π: float = 1.0,
):
    if False:
        print(rewardRisk, π)
    def helper(shadowed):
        return shadowed + captured
    print(helper(1), [shadowed for shadowed in range(2)])
`;
    const parameters = await worker.request(parameterSource);
    assert(parameters.ok, 'used-parameters: analyzer failed');
    const parameterNames = (parameters.usedParameters ?? []).map(([line, start, end]) =>
      parameterSource.split('\n')[line].slice(start, end)
    );
    assert(
      JSON.stringify(parameterNames) === JSON.stringify(['rewardRisk', 'captured', 'π', 'shadowed']),
      `used-parameters: closure/shadowing/UTF-16 mismatch: ${JSON.stringify(parameterNames)}`
    );
    log('used-parameters OK (dead-branch reads, closures, shadowing, annotated Unicode names)');

    // --- missing main: one pyne-main-missing anchored on line 0 --------------
    const missing = await worker.request(HEAD + 'def helper():\n    pass\n');
    expectCodes(missing, ['pyne-main-missing'], 'missing-main');
    assert(missing.problems![0][0] === 0, `missing-main: expected line 0, got ${missing.problems![0][0]}`);
    log('missing-main OK');

    // --- `@pyne lib` module: main is not required ----------------------------
    const libModule = await worker.request(
      '"""\n@pyne lib\n"""\n' +
        '__all__ = ["myFunction"]\n\n\n' +
        'def myFunction():\n    pass\n\n\n' +
        'def helper():\n    pass\n'
    );
    expectCodes(libModule, [], 'lib-module');
    assert(
      JSON.stringify(libModule.exports) === JSON.stringify([[6, 4, 14]]),
      `lib-module: expected only the public function span, got ${JSON.stringify(libModule.exports)}`
    );
    log('lib-module OK');

    // --- pynecore @overload defs are reported for the redeclaration filter ---
    const overloads = await worker.request(
      HEAD +
        'from pynecore.lib import script\n' +
        'from pynecore.core.overload import overload\n\n\n' +
        '@overload\n' +
        'def f(a: float) -> float:\n' +
        '    return a\n\n\n' +
        '@overload\n' +
        'def f(a: int) -> int:\n' +
        '    return a\n\n\n' +
        'def plain():\n' +
        '    pass\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    pass\n'
    );
    assert(overloads.ok, `overloads: worker returned ok:false (${overloads.error ?? 'no error'})`);
    const spans = overloads.overloads ?? [];
    assert(
      spans.length === 2 && spans.every((s) => s[2] - s[1] === 1),
      `overloads: expected two one-char name spans, got ${JSON.stringify(spans)}`
    );
    log('overloads OK');

    // --- undecorated main ----------------------------------------------------
    const undecorated = await worker.request(
      HEAD + 'from pynecore.lib import script\n\n\ndef main():\n    pass\n'
    );
    expectCodes(undecorated, ['pyne-main-undecorated'], 'undecorated-main');
    log('undecorated-main OK');

    // --- bare @script.indicator (not called): message says "as a call" -------
    const bare = await worker.request(
      HEAD + 'from pynecore.lib import script\n\n\n@script.indicator\ndef main():\n    pass\n'
    );
    expectCodes(bare, ['pyne-main-undecorated'], 'bare-decorator');
    assert(
      /as a call/.test(messagesOf(bare)[0] ?? ''),
      `bare-decorator: message should mention applying it as a call, got ${JSON.stringify(messagesOf(bare))}`
    );
    log('bare-decorator OK');

    // --- module-level Series declaration -------------------------------------
    const seriesScope = await worker.request(
      HEAD +
        'from pynecore import Series\n' +
        'from pynecore.lib import script, close\n\n\n' +
        's: Series[float] = close\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    pass\n'
    );
    expectCodes(seriesScope, ['pyne-series-scope'], 'series-scope');
    log('series-scope OK');

    // --- module-level Persistent declaration ---------------------------------
    const persistentScope = await worker.request(
      HEAD +
        'from pynecore.lib import script\n' +
        'from pynecore.types import Persistent\n\n\n' +
        'p: Persistent[int] = 0\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    pass\n'
    );
    expectCodes(persistentScope, ['pyne-persistent-scope'], 'persistent-scope');
    log('persistent-scope OK');

    // --- aliased lib import --------------------------------------------------
    const libAlias = await worker.request(
      HEAD +
        'from pynecore import lib as l\n' +
        'from pynecore.lib import script\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    print(l)\n'
    );
    expectCodes(libAlias, ['pyne-lib-alias'], 'lib-alias');
    log('lib-alias OK');

    // --- strategy state in a request.security expression ---------------------
    // Positional and keyword `expression` are flagged; a harmless
    // `strategy.entry` (not strategy state) is not.
    const security = await worker.request(
      HEAD +
        'from pynecore.lib import script, request, strategy, syminfo\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    a = request.security(syminfo.tickerid, "1D", strategy.equity)\n' +
        '    b = request.security(syminfo.tickerid, "1D", expression=strategy.position_size)\n' +
        '    c = request.security(syminfo.tickerid, "1D", strategy.entry)\n' +
        '    print(a, b, c)\n'
    );
    expectCodes(
      security,
      ['pyne-security-strategy-state', 'pyne-security-strategy-state'],
      'security-strategy-state'
    );
    assert(
      messagesOf(security).some((m) => /equity/.test(m)) &&
        messagesOf(security).some((m) => /position_size/.test(m)),
      `security-strategy-state: messages should cover equity and position_size, got ${JSON.stringify(messagesOf(security))}`
    );
    assert(
      !messagesOf(security).some((m) => /entry/.test(m)),
      `security-strategy-state: strategy.entry must not be flagged, got ${JSON.stringify(messagesOf(security))}`
    );
    log('security-strategy-state OK');

    // --- lib-chain and from-import forms of the security expression ----------
    const securityForms = await worker.request(
      HEAD +
        'from pynecore import lib\n' +
        'from pynecore.lib.strategy import netprofit\n' +
        'from pynecore.lib import script, syminfo\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    a = lib.request.security(syminfo.tickerid, "1D", lib.strategy.openprofit)\n' +
        '    b = lib.request.security(syminfo.tickerid, "1D", expression=netprofit)\n' +
        '    print(a, b)\n'
    );
    expectCodes(
      securityForms,
      ['pyne-security-strategy-state', 'pyne-security-strategy-state'],
      'security-forms'
    );
    log('security-forms OK');

    // --- parameter shadowing: helper params shadow the lib imports -----------
    const shadow = await worker.request(
      HEAD +
        'from pynecore.lib import script, request, strategy, syminfo\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    pass\n\n\n' +
        'def helper(request, strategy):\n' +
        '    return request.security("X", "1D", strategy.equity)\n'
    );
    expectCodes(shadow, [], 'shadow');
    log('shadow OK');

    // --- unknown decorator: conservative rule stays silent -------------------
    const unknownDecorator = await worker.request(
      HEAD + 'import functools\n\n\n@functools.cache\ndef main():\n    pass\n'
    );
    expectCodes(unknownDecorator, [], 'unknown-decorator');
    log('unknown-decorator OK');

    // --- internal-test-module gate: __test_*__ function ----------------------
    const testFn = await worker.request(
      HEAD + 'def __test_something__():\n    pass\n\n\ndef main():\n    pass\n'
    );
    expectCodes(testFn, [], 'internal-test-fn');
    log('internal-test-fn OK');

    // --- internal-test-module gate: __pyne*__ binding ------------------------
    const pyneDunder = await worker.request(
      HEAD + '__pyne_slot_layout__ = {}\n\n\ndef main():\n    pass\n'
    );
    expectCodes(pyneDunder, [], 'internal-pyne-dunder');
    log('internal-pyne-dunder OK');

    // --- syntactically broken source: ok:false, and the worker recovers ------
    const broken = await worker.request(HEAD + 'def main(:\n    pass\n');
    assert(broken.ok === false, `broken: expected ok:false, got ${JSON.stringify(broken)}`);
    const recovered = await worker.request(HEAD + 'def helper():\n    pass\n');
    expectCodes(recovered, ['pyne-main-missing'], 'broken-recovery');
    log('broken-source OK (ok:false, worker still answers the next request)');

    // ======================= Pyne Edge profile (F8) =========================
    // Edge sources run the fail-closed DSL linter on top of the rules above.
    const EDGE_HEAD = '"""@pyne edge"""\n';
    const SCAFFOLD =
      'from pynecore.lib import script\n\n\n' +
      '@script.indicator(title="T")\n' +
      'def main():\n' +
      '    pass\n';

    // --- a full valid Edge script: every allowed construct at once -----------
    const edgeValid = await worker.request(
      EDGE_HEAD +
        'from pynecore import Series\n' +
        'from pynecore.core.pine_method import method\n' +
        'from pynecore.core.pine_udt import udt\n' +
        'from dataclasses import field\n' +
        'from pynecore.lib import script, close, ta, plot\n' +
        'from pynecore.standalone import run\n' +
        'import lib.TradingView.ta.v8\n\n\n' +
        '@udt\n' +
        'class Settings:\n' +
        '    length: int = 14\n' +
        '    source: float = field(default_factory=lambda: 0.0)\n\n\n' +
        '@method\n' +
        'def bump(s: float, n: float) -> float:\n' +
        '    return s + n\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    s: Series[float] = close\n' +
        '    prev = s[1]\n' +
        '    total = 0.0\n' +
        '    i = 0\n' +
        '    while i < 3:\n' +
        '        total += ta.sma(close, 5)\n' +
        '        i += 1\n' +
        '        if i == 2:\n' +
        '            break\n' +
        '    for k in range(3):\n' +
        '        total = total + k\n' +
        '    assert total >= 0, "total is a sum of non-negatives"\n' +
        '    assert i > 0\n' +
        '    if i in (1, 2) and k not in (7, 8):\n' +
        '        total = total + 1\n' +
        '    plot(bump(total, prev))\n\n\n' +
        'if __name__ == "__main__":\n' +
        '    run(main)\n'
    );
    expectCodes(edgeValid, [], 'edge-valid');
    assert((edgeValid.spans ?? []).length > 0, 'edge-valid: expected non-empty spans');
    assert((edgeValid.refs ?? []).length > 0, 'edge-valid: expected non-empty refs');
    log('edge-valid OK');

    // --- gate + marker variants (guards the PYNE_EDGE_RE port) ---------------
    const probe = 'import numpy\n' + SCAFFOLD;
    const gate = await worker.request('"""\n@pyne\n"""\n' + probe);
    expectCodes(gate, [], 'edge-gate (plain @pyne)');
    const commented = await worker.request(
      '# a leading comment\n# /// script\n"""@pyne edge"""\n' + probe
    );
    expectCodes(commented, ['pyne-edge-import'], 'edge-marker (leading comments)');
    const singleQuotes = await worker.request("'''@pyne  edge'''\n" + probe);
    expectCodes(singleQuotes, ['pyne-edge-import'], 'edge-marker (single quotes, double space)');
    const glued = await worker.request('"""@pyneedge"""\n' + probe);
    expectCodes(glued, [], 'edge-marker (@pyneedge is not a marker)');
    const edgy = await worker.request('"""@pyne edgy"""\n' + probe);
    expectCodes(edgy, [], 'edge-marker (@pyne edgy is plain pyne)');
    log('edge-gate + marker variants OK');

    // --- imports: whitelist, and a flagged import does not cascade to uses ---
    const edgeImports = await worker.request(
      EDGE_HEAD +
        'from math import floor\n' +
        'from pynecore.lib import script\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    x = floor(1.5)\n' +
        '    print(x)\n'
    );
    expectCodes(edgeImports, ['pyne-edge-import'], 'edge-import (no cascade to floor())');
    log('edge-import OK');

    // --- syntax: one report per disallowed construct, in line order ----------
    const edgeSyntax = await worker.request(
      EDGE_HEAD +
        'from pynecore.lib import script\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    xs = [1, 2]\n' +
        '    s = f"v"\n' +
        '    y = 1 << 2\n' +
        '    match y:\n' +
        '        case 1:\n' +
        '            pass\n' +
        '    print(xs, s, y)\n'
    );
    expectCodes(
      edgeSyntax,
      ['pyne-edge-syntax', 'pyne-edge-syntax', 'pyne-edge-syntax', 'pyne-edge-syntax'],
      'edge-syntax'
    );
    {
      const msgs = messagesOf(edgeSyntax);
      for (const needle of ['list literal', 'f-string', "'<<'", "'match'"]) {
        assert(
          msgs.some((m) => m.includes(needle)),
          `edge-syntax: expected a message mentioning ${needle}, got ${JSON.stringify(msgs)}`
        );
      }
    }
    log('edge-syntax OK');

    // --- assert: allowed, but its message must be a string literal ----------
    const edgeAssert = await worker.request(
      EDGE_HEAD +
        'from pynecore.lib import script\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    n = 3\n' +
        '    assert n > 0, "n" + "!"\n'
    );
    expectCodes(edgeAssert, ['pyne-edge-assert'], 'edge-assert (non-literal message)');
    log('edge-assert OK');

    // --- async + special parameters ------------------------------------------
    const edgeAsync = await worker.request(
      EDGE_HEAD +
        SCAFFOLD +
        '\n\nasync def gather():\n    pass\n\n\ndef helper(*args):\n    pass\n'
    );
    expectCodes(edgeAsync, ['pyne-edge-syntax', 'pyne-edge-syntax'], 'edge-async-signature');
    log('edge-async-signature OK');

    // --- decorators: only the built-in set exists -----------------------------
    const edgeDecorator = await worker.request(
      EDGE_HEAD +
        SCAFFOLD +
        '\n\ndef deco(f):\n    return f\n\n\n@deco\ndef g():\n    return 1\n'
    );
    expectCodes(edgeDecorator, ['pyne-edge-decorator'], 'edge-decorator');
    log('edge-decorator OK');

    // --- classes: undecorated / inherited classes are not UDTs ---------------
    const edgeClass = await worker.request(
      EDGE_HEAD + SCAFFOLD + '\n\nclass State:\n    count: int = 0\n'
    );
    expectCodes(edgeClass, ['pyne-edge-class'], 'edge-class');
    log('edge-class OK');

    // --- class methods: undecorated with a receiver, Pine's `method` ---------
    const edgeMethod = await worker.request(
      EDGE_HEAD +
        'from pynecore.core.pine_udt import udt\n' +
        SCAFFOLD +
        '\n\n@udt\nclass Pair:\n    a: float = 0.0\n\n' +
        '    def doubled(self) -> float:\n        return self.a * 2\n'
    );
    expectCodes(edgeMethod, [], 'edge-method');
    log('edge-method OK');

    const edgeMethodDecorated = await worker.request(
      EDGE_HEAD +
        'from pynecore.core.pine_udt import udt\n' +
        SCAFFOLD +
        '\n\n@udt\nclass Pair:\n    a: float = 0.0\n\n' +
        '    @staticmethod\n    def zero() -> float:\n        return 0.0\n'
    );
    expectCodes(edgeMethodDecorated, ['pyne-edge-decorator', 'pyne-edge-class'],
      'edge-method-decorated');
    log('edge-method-decorated OK');

    // --- calls: unknown bare names (and with them every escape hatch) --------
    const edgeCall = await worker.request(
      EDGE_HEAD +
        'from pynecore.lib import script\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    exec("1")\n' +
        '    q = getattr(main, "x")\n' +
        '    print(q)\n'
    );
    expectCodes(edgeCall, ['pyne-edge-call', 'pyne-edge-call'], 'edge-call');
    log('edge-call OK');

    // --- Python's builtin open must not hide a missing price-series import ---
    const openScaffold =
      'from pynecore.lib import script, plot\n' +
      '@script.indicator(title="T")\n';
    const missingOpenSource = EDGE_HEAD + openScaffold +
      'def main():\n' +
      '    plot(open)\n' +
      '    plot(open[1])\n' +
      '    price = open + 1\n' +
      '    open("prices.csv")\n';
    const missingOpen = await worker.request(missingOpenSource);
    expectCodes(missingOpen, Array(4).fill('pyne-edge-builtin'), 'edge-missing-open');
    for (const [line, start, end, , message] of missingOpen.problems ?? []) {
      assert(missingOpenSource.split('\n')[line].slice(start, end) === 'open',
        'edge-missing-open: diagnostic must underline only open');
      assert(message.includes('from pynecore.lib import open'),
        'edge-missing-open: diagnostic must explain the missing series import');
    }
    expectCodes(await worker.request(missingOpenSource.replace(EDGE_HEAD, HEAD)), [],
      'plain-pyne-builtin-open');
    expectCodes(await worker.request(EDGE_HEAD +
      'from pynecore.lib import open\n' + openScaffold +
      'def main():\n    plot(open)\n    plot(open[1])\n'), [], 'edge-imported-open');
    for (const [label, body] of [
      ['parameter', 'def main(open: float = 1.0):\n    plot(open)\n'],
      ['local', 'def main():\n    open = 1.0\n    plot(open)\n'],
      ['closure', 'def main():\n    open = 1.0\n    def price():\n        return open\n    plot(price())\n'],
      ['local-import', 'def main():\n    from pynecore.lib import open\n    plot(open)\n'],
      ['lifted-import', 'def main():\n    plot(open)\ndef helper():\n    from pynecore.lib import open\n    return open\n'],
      ['loop', 'def main():\n    for open in (1.0, 2.0):\n        plot(open)\n'],
    ]) {
      expectCodes(await worker.request(EDGE_HEAD + openScaffold + body), [], `edge-open-${label}`);
    }
    for (const [label, body] of [
      ['sibling-import', 'def main():\n    plot(open)\ndef helper():\n    from lib.Example.v1 import open\n    return open\n'],
      ['sibling-parameter', 'def main():\n    plot(open)\ndef helper(open):\n    return open\n'],
      // Only a `from` lib import standing directly in a function body is lifted
      ['sibling-module-import',
        'def main():\n    plot(open)\ndef helper():\n    import pynecore.lib as open\n    return open\n'],
      ['sibling-conditional-import',
        'def main():\n    plot(open)\ndef helper(c: bool):\n    if c:\n' +
        '        from pynecore.lib import open\n    return 1.0\n'],
      ['aliased-import', 'def main():\n    from pynecore.lib import open as price\n    plot(price)\n    plot(open)\n'],
      ['default', 'def main(open: float = open):\n    plot(open)\n'],
      ['nested-default', 'def main():\n    def price(open: float = open):\n        return open\n    plot(price())\n'],
    ]) {
      expectCodes(await worker.request(EDGE_HEAD + openScaffold + body), ['pyne-edge-builtin'],
        `edge-open-${label}`);
    }
    // A star import is reported once, wherever it stands: its uses do not cascade
    for (const [label, declaration] of [
      ['module', 'from pynecore.lib import *\n'],
      ['conditional', 'if 1.0 < 0.0:\n    from pynecore.lib import *\nx = open\n'],
      ['after-read', 'x = input.int(14)\nif 1.0 > 0.0:\n    from pynecore.lib import *\n'],
    ]) {
      expectCodes(await worker.request(EDGE_HEAD + declaration + openScaffold +
        'def main():\n    plot(open)\n'), ['pyne-edge-import'], `edge-star-import-${label}`);
    }
    // An annotation without a value declares the name and binds nothing
    expectCodes(await worker.request(EDGE_HEAD + 'open: float\n' + openScaffold +
      'def main():\n    plot(open)\n'), ['pyne-edge-builtin'], 'edge-open-annotation-only');
    expectCodes(await worker.request(EDGE_HEAD + 'open: float = 1.0\n' + openScaffold +
      'def main():\n    plot(open)\n'), [], 'edge-open-annotated-value');
    // The module is initialized top to bottom: a read that runs meanwhile sees
    // only the bindings made ahead of it, its own assignment's not yet
    for (const [label, declaration] of [
      ['self-initializer', 'open: float = open\n'],
      ['later-assignment', 'x = open\nopen = 1.0\n'],
      ['later-default', 'def price(a: float = open):\n    return a\nopen = 1.0\n'],
      ['loop-iterable', 'for open in open:\n    x = 1.0\n'],
    ]) {
      expectCodes(await worker.request(EDGE_HEAD + declaration + openScaffold +
        'def main():\n    plot(open + 1.0)\n'), ['pyne-edge-builtin'], `edge-open-${label}`);
    }
    for (const [label, declaration] of [
      ['earlier-assignment', 'open = 1.0\nx = open\n'],
      ['conditional-assignment', 'if 1.0 > 0.0:\n    open = 1.0\n    x = open\n'],
      ['module-loop', 'for open in (1.0, 2.0):\n    x = open\n'],
    ]) {
      expectCodes(await worker.request(EDGE_HEAD + declaration + openScaffold +
        'def main():\n    plot(open + 1.0)\n'), [], `edge-open-${label}`);
    }
    // A function body is taken to run once the module is initialized
    expectCodes(await worker.request(EDGE_HEAD + openScaffold +
      'def main():\n    plot(open + 1.0)\nopen = 1.0\n'), [], 'edge-open-later-module-binding');
    log('edge-open OK (missing import, exact spans, scope bindings, defaults, plain Pyne)');

    // --- input is the other lib name Python's builtins would answer ----------
    const missingInputSource = EDGE_HEAD + openScaffold +
      'def main():\n' +
      '    length = input.int(14)\n' +
      '    plot(input(1.0) + length)\n';
    const missingInput = await worker.request(missingInputSource);
    expectCodes(missingInput, ['pyne-edge-builtin', 'pyne-edge-builtin'], 'edge-missing-input');
    for (const [line, start, end, , message] of missingInput.problems ?? []) {
      assert(missingInputSource.split('\n')[line].slice(start, end) === 'input',
        'edge-missing-input: diagnostic must underline only input');
      assert(message.includes('from pynecore.lib import input'),
        'edge-missing-input: diagnostic must explain the missing input import');
    }
    expectCodes(await worker.request(EDGE_HEAD +
      'from pynecore.lib import input\n' + openScaffold +
      'def main():\n    length = input.int(14)\n    plot(input(1.0) + length)\n'), [],
      'edge-imported-input');
    log('edge-input OK');

    // --- a class body reads its own field only once the field is assigned ----
    const classHead = EDGE_HEAD + 'from pynecore.core.pine_udt import udt\n' +
      'from pynecore.lib import script\n';
    const classTail = '@script.indicator(title="T")\ndef main():\n    pass\n';
    for (const [label, body] of [
      ['own-default', '@udt\nclass State:\n    open: float = open\n'],
      ['own-default-input', '@udt\nclass State:\n    input: int = input.int(14)\n'],
      ['annotation-only', '@udt\nclass State:\n    open: float\n    mid: float = open\n'],
      ['nested-own-default',
        'def helper():\n    open = 1.0\n\n    @udt\n    class State:\n        open: float = open\n' +
        '    return State()\n'],
    ]) {
      expectCodes(await worker.request(classHead + body + classTail), ['pyne-edge-builtin'],
        `edge-class-${label}`);
    }
    for (const [label, body] of [
      ['field-above', '@udt\nclass State:\n    open: float = 0.0\n    mid: float = open\n'],
      ['enclosing-local',
        'def helper():\n    open = 1.0\n\n    @udt\n    class State:\n        mid: float = open\n' +
        '    return State()\n'],
    ]) {
      expectCodes(await worker.request(classHead + body + classTail), [], `edge-class-${label}`);
    }
    log('edge-class-builtin OK (own field ahead of its assignment, after it, enclosing local)');

    // --- an error only the symbol table raises leaves the other rules running -
    expectCodes(await worker.request(EDGE_HEAD + SCAFFOLD + '\n\nnonlocal x\n'),
      ['pyne-edge-syntax'], 'edge-symtable-error');
    expectCodes(await worker.request(EDGE_HEAD + openScaffold +
      'def main():\n    plot(open)\ndef f(a, a):\n    return a\n'), [],
      'edge-symtable-error-builtin-silent');
    log('edge-symtable-error OK (Edge rules answer, the builtin-read rule falls silent)');

    // --- functions/modules are not objects -----------------------------------
    const edgeFuncAttr = await worker.request(EDGE_HEAD + SCAFFOLD + '\n\nmain.cache = 1\n');
    expectCodes(edgeFuncAttr, ['pyne-edge-func-attr'], 'edge-func-attr');
    log('edge-func-attr OK');

    // --- lambda outside a UDT field default ----------------------------------
    const edgeLambda = await worker.request(EDGE_HEAD + SCAFFOLD + '\n\nf2 = lambda: 1\n');
    expectCodes(edgeLambda, ['pyne-edge-lambda'], 'edge-lambda');
    log('edge-lambda OK');

    // --- subscript stores (history reads stay allowed) -----------------------
    const edgeSubscript = await worker.request(
      EDGE_HEAD +
        'from pynecore.lib import script, close\n\n\n' +
        '@script.indicator(title="T")\n' +
        'def main():\n' +
        '    p = close\n' +
        '    p[0] = 1.0\n' +
        '    print(close[1])\n'
    );
    expectCodes(edgeSubscript, ['pyne-edge-subscript'], 'edge-subscript');
    log('edge-subscript OK');

    // --- edge + structure problems coexist in one sorted list ----------------
    const edgeCoexist = await worker.request(
      EDGE_HEAD +
        'import numpy\n' +
        'from pynecore.lib import script\n\n\n' +
        'def main():\n' +
        '    pass\n'
    );
    expectCodes(edgeCoexist, ['pyne-edge-import', 'pyne-main-undecorated'], 'edge-coexist');
    log('edge-coexist OK');

    // --- the internal-test-module gate silences Edge rules too ---------------
    const edgeInternal = await worker.request(
      EDGE_HEAD + '__pyne_slot_layout__ = {}\nimport numpy\n\n\ndef main():\n    pass\n'
    );
    expectCodes(edgeInternal, [], 'edge-internal-module');
    log('edge-internal-module OK');

    log('CHECKER SMOKE OK');
  } finally {
    worker.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
