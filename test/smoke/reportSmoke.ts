/**
 * Problem-report smoke test — verifies the pure, VSCode-free core of the
 * "Report a Problem" feature: what leaves the machine and what never does.
 *
 * Usage: node dist/report-smoke.js
 * Needs no VSCode runtime, no Python and no network.
 *
 * Assertions:
 *   (a) scrubText replaces all five roots with both separators;
 *   (b) scrubText removes JWTs, Bearer headers, `api_key = "..."` assignments
 *       and URL userinfo;
 *   (c) stripTracebackSource drops the quoted source and caret lines but keeps
 *       every `File "...", line N` header and the final exception line, and
 *       leaves ordinary log lines alone;
 *   (d) finalizePayload without consent drops the script, keeps script_sha256
 *       and strips source lines from the logs and the traceback;
 *   (e) truncation keeps the tail;
 *   (f) FailureRing evicts above its size and last() is the newest;
 *   (g) LogTee bounds its tail by both lines and characters, forwards to the
 *       inner channel and resets on clear/replace.
 */
import * as path from 'node:path';

import type * as vscode from 'vscode';

import { failures, FailureRing } from '../../src/report/lastFailure';
import { LogTee } from '../../src/report/logTee';
import { finalizePayload, MAX_LOG_CHARS, type ReportPayload } from '../../src/report/payload';
import { scrubText, stripTracebackSource, type ScrubRoots } from '../../src/report/scrub';

let failed = false;

/** Print a PASS/FAIL line; remember any failure so the process can exit non-zero. */
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failed = true;
    console.log(`  ✗ ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

/** Minimal in-memory OutputChannel to sit under a LogTee. */
class FakeChannel implements vscode.OutputChannel {
  written = '';
  shown = 0;
  disposed = false;
  constructor(readonly name = 'Fake') {}
  append(value: string): void {
    this.written += value;
  }
  appendLine(value: string): void {
    this.written += `${value}\n`;
  }
  replace(value: string): void {
    this.written = value;
  }
  clear(): void {
    this.written = '';
  }
  show(): void {
    this.shown += 1;
  }
  hide(): void {}
  dispose(): void {
    this.disposed = true;
  }
}

const ROOTS: ScrubRoots = {
  workdir: '/Users/tester/proj/workdir',
  workspace: '/Users/tester/proj',
  storage: '/Users/tester/Library/Application Support/Code/User/globalStorage/pynesys.pyneide',
  extension: '/Users/tester/.vscode/extensions/pynesys.pyneide-0.1.0',
  home: '/Users/tester',
};

const TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "/Users/tester/proj/workdir/scripts/strategy.py", line 42, in main',
  '    secret_alpha = compute(edge_ratio)',
  '                   ^^^^^^^^^^^^^^^^^^^',
  '  File "/Users/tester/proj/workdir/scripts/lib.py", line 7, in compute',
  '    return 1 / 0',
  'ZeroDivisionError: division by zero',
].join('\n');

function testScrub(): void {
  console.log('scrubText');

  const text = [
    'run: /Users/tester/proj/workdir/scripts/a.py',
    'ws: /Users/tester/proj/README.md',
    'storage: /Users/tester/Library/Application Support/Code/User/globalStorage/pynesys.pyneide/venv/bin/python',
    'ext: /Users/tester/.vscode/extensions/pynesys.pyneide-0.1.0/python',
    'home: /Users/tester/.cache',
    // Same root, backslash separators — a path logged by a Windows subprocess.
    'mixed: /Users/tester/proj/workdir\\scripts\\a.py',
  ].join('\n');
  const scrubbed = scrubText(text, ROOTS);

  check('(a) workdir -> <workdir>', scrubbed.includes('<workdir>/scripts/a.py'), scrubbed);
  check('(a) workspace -> <workspace>', scrubbed.includes('<workspace>/README.md'), scrubbed);
  check('(a) storage -> <storage>', scrubbed.includes('<storage>/venv/bin/python'), scrubbed);
  check('(a) extension -> <ext>', scrubbed.includes('<ext>/python'), scrubbed);
  check('(a) home -> ~', scrubbed.includes('~/.cache'), scrubbed);
  check(
    '(a) both separators match one root',
    scrubbed.includes('<workdir>\\scripts\\a.py'),
    scrubbed
  );
  check('(a) no /Users/ survives', !scrubbed.includes('/Users/'), scrubbed);

  // A Windows install: drive-letter roots, backslash separators.
  const winRoots: ScrubRoots = {
    workdir: 'C:\\Users\\tester\\proj\\workdir',
    workspace: 'C:\\Users\\tester\\proj',
    home: 'C:\\Users\\tester',
  };
  const win = scrubText(
    'C:\\Users\\tester\\proj\\workdir\\scripts\\a.py and C:\\Users\\tester\\AppData',
    winRoots
  );
  check('(a) windows workdir -> <workdir>', win.includes('<workdir>\\scripts\\a.py'), win);
  check('(a) windows home -> ~', win.includes('~\\AppData'), win);

  const secrets = [
    'Authorization: Bearer abc.def.ghi',
    'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
    'api_key = "sk-live-1234567890"',
    'fetching https://user:hunter2@api.example.com/v1',
  ].join('\n');
  const cleaned = scrubText(secrets, ROOTS);

  check('(b) Bearer token removed', !cleaned.includes('abc.def.ghi'), cleaned);
  check('(b) JWT removed', !cleaned.includes('eyJhbGciOiJIUzI1NiJ9'), cleaned);
  check('(b) api_key value removed', !cleaned.includes('sk-live-1234567890'), cleaned);
  check('(b) URL userinfo removed', !cleaned.includes('hunter2'), cleaned);
  check('(b) host survives', cleaned.includes('api.example.com'), cleaned);
}

function testStripTraceback(): void {
  console.log('stripTracebackSource');

  const stripped = stripTracebackSource(TRACEBACK);

  check('(c) quoted source line removed', !stripped.includes('secret_alpha = compute'), stripped);
  check('(c) caret line removed', !stripped.includes('^^^'), stripped);
  check('(c) second frame source removed', !stripped.includes('return 1 / 0'), stripped);
  check(
    '(c) both File headers kept',
    (stripped.match(/File "/g) ?? []).length === 2,
    stripped
  );
  check(
    '(c) exception line kept',
    stripped.includes('ZeroDivisionError: division by zero'),
    stripped
  );
  check(
    '(c) one marker per frame',
    (stripped.match(/<source lines removed>/g) ?? []).length === 2,
    stripped
  );

  const log = ['[info] compiling', '    indented continuation', '[info] done'].join('\n');
  check('(c) ordinary log untouched', stripTracebackSource(log) === log, stripTracebackSource(log));
}

function testFinalize(): void {
  console.log('finalizePayload');

  const draft: ReportPayload = {
    schema_version: 1,
    client: 'pyneide',
    client_version: '0.1.0',
    source: 'runtime',
    summary: 'failed in /Users/tester/proj/workdir/scripts/strategy.py',
    include_script: false,
    script: '//@version=6\nindicator("mine")',
    script_language: 'pine',
    script_sha256: 'abc123',
    logs: `spawn /Users/tester/proj/workdir\n${TRACEBACK}`,
    context: { traceback: TRACEBACK, nested: { path: '/Users/tester/proj/README.md' } },
  };

  const without = finalizePayload(draft, { includeScript: false, roots: ROOTS });
  check('(d) script dropped', without.script === null, String(without.script));
  check('(d) include_script is false', without.include_script === false);
  check('(d) script_sha256 kept', without.script_sha256 === 'abc123');
  check('(d) summary scrubbed', without.summary.includes('<workdir>'), without.summary);
  check(
    '(d) logs lost the source lines',
    !String(without.logs).includes('secret_alpha = compute'),
    String(without.logs)
  );
  check(
    '(d) context.traceback lost the source lines',
    !String(without.context.traceback).includes('secret_alpha = compute'),
    String(without.context.traceback)
  );
  check(
    '(d) nested context strings scrubbed',
    JSON.stringify(without.context).includes('<workspace>') &&
      !JSON.stringify(without.context).includes('/Users/'),
    JSON.stringify(without.context)
  );

  const with_ = finalizePayload(draft, { includeScript: true, roots: ROOTS });
  check('(d) with consent the script is kept', with_.script === draft.script, String(with_.script));
  check(
    '(d) with consent the traceback source is kept',
    String(with_.context.traceback).includes('secret_alpha = compute')
  );

  const long = `${'x'.repeat(MAX_LOG_CHARS)}TAIL-MARKER`;
  const truncated = finalizePayload(
    { ...draft, logs: long },
    { includeScript: false, roots: ROOTS }
  );
  const logs = String(truncated.logs);
  check('(e) truncation keeps the tail', logs.endsWith('TAIL-MARKER'), logs.slice(-40));
  check('(e) truncation is marked', logs.startsWith('… [truncated '), logs.slice(0, 40));
}

function testFailureRing(): void {
  console.log('FailureRing');

  const ring = new FailureRing(2);
  ring.record({ kind: 'compile', summary: 'first' });
  ring.record({ kind: 'compile', summary: 'second' });
  ring.record({ kind: 'runtime', summary: 'third' });

  check('(f) evicts above its size', ring.all().length === 2, String(ring.all().length));
  check('(f) last() is the newest', ring.last()?.summary === 'third', ring.last()?.summary);
  check('(f) oldest was dropped', !ring.all().some((r) => r.summary === 'first'));
  check('(f) shared ring starts empty', failures.last() === undefined);
}

function testLogTee(): void {
  console.log('LogTee');

  const inner = new FakeChannel('PyneIDE Test');
  const tee = new LogTee(inner, 3, 1000);
  // Compile-time interface conformance: a LogTee must be usable anywhere an
  // OutputChannel is expected (this is what makes the wrap() sites one-liners).
  const asChannel: vscode.OutputChannel = tee;
  check('(g) name is forwarded', asChannel.name === 'PyneIDE Test', asChannel.name);

  for (const line of ['one', 'two', 'three', 'four']) tee.appendLine(line);
  check('(g) forwards to the inner channel', inner.written.includes('four'), inner.written);
  check('(g) line limit evicts the oldest', tee.tail() === 'two\nthree\nfour', tee.tail());

  const charTee = new LogTee(new FakeChannel(), 100, 20);
  charTee.appendLine('a'.repeat(15));
  charTee.appendLine('b'.repeat(15));
  check('(g) char limit evicts the oldest', !charTee.tail().includes('a'), charTee.tail());

  const partial = new LogTee(new FakeChannel(), 10, 1000);
  partial.append('half');
  partial.append(' line\nnext');
  check('(g) partial appends join into lines', partial.tail() === 'half line\nnext', partial.tail());

  tee.clear();
  check('(g) clear resets the tail', tee.tail() === '');
  tee.replace('fresh');
  check('(g) replace resets the tail', tee.tail() === 'fresh', tee.tail());
  tee.show();
  check('(g) show is forwarded', inner.shown === 1, String(inner.shown));
  tee.dispose();
  check('(g) dispose is forwarded', inner.disposed);
}

function main(): void {
  console.log(`--- ${path.basename(__filename)}`);
  testScrub();
  testStripTraceback();
  testFinalize();
  testFailureRing();
  testLogTee();

  if (failed) {
    console.log('REPORT SMOKE FAILED');
    process.exit(1);
  }
  console.log('REPORT SMOKE OK');
}

main();
