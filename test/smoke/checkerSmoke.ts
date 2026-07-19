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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

const log = (msg: string): void => console.log(msg);

type Span = [number, number, number];
type Ref = [number, number, number, string];
type Problem = [number, number, number, string, string];

interface WorkerResponse {
  id: number;
  ok: boolean;
  spans?: Span[];
  refs?: Ref[];
  problems?: Problem[];
  error?: string;
}

/**
 * A single long-lived worker process. Requests get incrementing ids and are
 * resolved as their matching response line arrives; a global deadline fails any
 * still-pending request so a hung worker cannot wedge the test.
 */
class Worker {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (r: WorkerResponse) => void>();
  private readonly rejects = new Map<number, (e: Error) => void>();
  private readonly timer: NodeJS.Timeout;
  private buffer = '';
  private nextId = 1;
  private stderr = '';

  constructor(timeoutMs: number) {
    const script = path.resolve('python/pyneide_series.py');
    const python = process.platform === 'win32' ? 'python' : 'python3';
    this.proc = spawn(python, ['-u', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.timer = setTimeout(() => this.failAll(new Error('checker worker timed out')), timeoutMs);
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.proc.on('error', (e) => this.failAll(new Error(`checker worker could not start (${python}): ${e.message}`)));
  }

  request(source: string): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, resolve);
      this.rejects.set(id, reject);
      this.proc.stdin.write(JSON.stringify({ id, source }) + '\n');
    });
  }

  close(): void {
    clearTimeout(this.timer);
    this.proc.kill();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const response = JSON.parse(line) as WorkerResponse;
      const resolve = this.pending.get(response.id);
      if (resolve) {
        this.pending.delete(response.id);
        this.rejects.delete(response.id);
        resolve(response);
      }
    }
  }

  private failAll(error: Error): void {
    clearTimeout(this.timer);
    if (this.stderr) error.message += `\n--- worker stderr ---\n${this.stderr}`;
    for (const reject of this.rejects.values()) reject(error);
    this.pending.clear();
    this.rejects.clear();
    this.proc.kill();
  }
}

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

    // --- missing main: one pyne-main-missing anchored on line 0 --------------
    const missing = await worker.request(HEAD + 'def helper():\n    pass\n');
    expectCodes(missing, ['pyne-main-missing'], 'missing-main');
    assert(missing.problems![0][0] === 0, `missing-main: expected line 0, got ${missing.problems![0][0]}`);
    log('missing-main OK');

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

    log('CHECKER SMOKE OK');
  } finally {
    worker.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
