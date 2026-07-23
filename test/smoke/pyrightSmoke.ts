/**
 * Bundled pyright smoke test — runs WITHOUT VSCode against the pyright copy
 * shipped in dist/pyright, driving it exactly like the extension does (LSP)
 * over a workspace produced by the real ensurePyrightConfig() generator.
 * Verifies the L5a/L5b/L5c contract:
 *  - the bundled server starts on plain Node and speaks LSP;
 *  - real type errors are reported (reportAssignmentType);
 *  - reportIndexIssue is silenced by the generated pyrightconfig.json
 *    (series history indexing noise under the transparent Series alias);
 *  - with `preciseIndexFilter` the rule comes back, and the real analyzer
 *    worker + span matching drop exactly the series accesses, keeping the
 *    genuine index error.
 * Usage: node dist/pyright-smoke.js
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ensurePyrightConfig } from '../../src/env/workdir';
import {
  isExactSpan,
  isSeriesAccess,
  seriesSpanIndex,
  type Span,
} from '../../src/typing/seriesFilter';
import { LspStdio } from './lspStdio';

const log = (msg: string): void => console.log(msg);

const PYNE_SCRIPT = `"""
@pyne
"""


def main() -> None:
    nums: int = 0
    bad: str = nums
    price = 1.23
    prev = price[1]
    print(bad, prev)
`;

/**
 * L5c probe. `s` and `close` are series accesses pynecomp rewrites into buffer
 * reads; `scalar[0]` is a genuine error that must survive the filter.
 */
const SERIES_SCRIPT = `"""
@pyne
"""
from pynecore import Series
from pynecore.lib import close


def main() -> None:
    s: Series[float] = close
    hist = s[1]
    lib_hist = close[2]
    scalar = 42
    broken = scalar[0]
    print(hist, lib_hist, broken)
`;

const LIB_SCRIPT = `"""
@pyne
"""

from pynecore.core.pine_export import export


def main() -> None:
    @export
    def myFunction() -> int:
        return 1

    def helper() -> int:
        return 2
`;

/**
 * A pynecore stand-in: the smoke test has no managed environment, but the
 * filter only needs the transparent alias shape that the real stubs have.
 */
const PYNECORE_STUB = `from typing import TypeAlias, TypeVar

T = TypeVar('T')
Series: TypeAlias = T
`;

const PYNECORE_LIB_STUB = `close: float = 0.0
`;

interface PublishParams {
  uri: string;
  diagnostics: {
    code?: unknown;
    message: string;
    severity?: number;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
  }[];
}

async function main(): Promise<void> {
  const serverModule = path.resolve('dist/pyright/langserver.index.js');
  if (!fs.existsSync(serverModule)) {
    throw new Error(`bundled pyright missing at ${serverModule} — run the build first`);
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-pyright-'));
  if (!ensurePyrightConfig(workdir)) throw new Error('ensurePyrightConfig: nothing was written');
  if (ensurePyrightConfig(workdir)) {
    throw new Error('ensurePyrightConfig: overwrote an existing config');
  }
  checkPythonVersionPinning(workdir);
  const scriptPath = path.join(workdir, 'scripts', 'demo.py');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, PYNE_SCRIPT);
  const scriptUri = pathToFileURL(scriptPath).toString();
  log(`Workspace: ${workdir}`);

  const diag = await diagnose(serverModule, workdir, scriptPath, scriptUri, PYNE_SCRIPT, (p) =>
    p.diagnostics.some((d) => d.code === 'reportAssignmentType')
  );

  const rules = diag.diagnostics.map((d) => d.code).filter(Boolean);
  if (rules.includes('reportIndexIssue')) {
    throw new Error(
      `generated config did not silence reportIndexIssue: ${JSON.stringify(diag.diagnostics)}`
    );
  }
  log(`Diagnostics OK (${diag.diagnostics.length} total, rules: ${rules.join(', ')})`);

  fs.rmSync(workdir, { recursive: true, force: true });

  await checkPreciseFilter(serverModule);
  await checkPullDiagnostics(serverModule);
  await checkLibraryExports(serverModule);
  log('PYRIGHT SMOKE OK');
}

/**
 * Pull-diagnostics regression guard: a capable client (the real
 * vscode-languageclient is one) makes pyright register `textDocument/diagnostic`
 * dynamically and serve diagnostics as request/response, which bypasses the
 * publish path — the extension filters those in the `provideDiagnostics`
 * middleware. This check proves the pull channel really is what a capable
 * client gets (raw index errors included) and that the same span filter
 * applies cleanly to its items.
 */
async function checkPullDiagnostics(serverModule: string): Promise<void> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-pull-'));
  ensurePyrightConfig(workdir, { preciseIndexFilter: true });
  fs.mkdirSync(path.join(workdir, 'pynecore'), { recursive: true });
  fs.writeFileSync(path.join(workdir, 'pynecore', '__init__.py'), PYNECORE_STUB);
  fs.writeFileSync(path.join(workdir, 'pynecore', 'lib.py'), PYNECORE_LIB_STUB);
  const scriptPath = path.join(workdir, 'scripts', 'series.py');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, SERIES_SCRIPT);
  const scriptUri = pathToFileURL(scriptPath).toString();

  const lsp = new LspStdio(process.execPath, [serverModule, '--stdio']);
  const registered = lsp.waitForNotification('client/registerCapability', 30000, (params) => {
    const p = params as { registrations?: { method?: string }[] };
    return (p.registrations ?? []).some((r) => r.method === 'textDocument/diagnostic');
  });
  await lsp.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(workdir).toString(),
    workspaceFolders: [{ uri: pathToFileURL(workdir).toString(), name: 'pull' }],
    capabilities: { textDocument: { diagnostic: { dynamicRegistration: true } } },
  });
  lsp.notify('initialized', {});
  await registered;
  lsp.notify('textDocument/didOpen', {
    textDocument: { uri: scriptUri, languageId: 'python', version: 1, text: SERIES_SCRIPT },
  });
  const report = (await lsp.request(
    'textDocument/diagnostic',
    { textDocument: { uri: scriptUri } },
    60000
  )) as { kind?: string; items?: PublishParams['diagnostics'] };
  if (report.kind !== 'full' || !report.items) {
    throw new Error(`pull diagnostics: unexpected report ${JSON.stringify(report)}`);
  }
  const indexDiags = report.items.filter((d) => d.code === 'reportIndexIssue');
  if (indexDiags.length !== 3) {
    throw new Error(
      `pull diagnostics: expected 3 raw index errors, got ${JSON.stringify(report.items)}`
    );
  }
  const index = seriesSpanIndex(await analyzeSpans(SERIES_SCRIPT));
  const lines = SERIES_SCRIPT.split('\n');
  const kept = indexDiags.filter(
    (d) =>
      !isSeriesAccess(
        index,
        lines[d.range.start.line] ?? '',
        d.range.start.line,
        d.range.start.character,
        d.range.end.character
      )
  );
  if (kept.length !== 1 || !/scalar/.test(lines[kept[0].range.start.line] ?? '')) {
    throw new Error(`pull filter kept the wrong diagnostics: ${JSON.stringify(kept)}`);
  }
  log(`Pull diagnostics OK (3 raw index errors over the pull channel -> 1 real)`);
  await lsp.request('shutdown');
  lsp.notify('exit');
  await lsp.exited();
  fs.rmSync(workdir, { recursive: true, force: true });
}

/**
 * The config must pin a Python version from the first write on, and adopt the
 * managed interpreter's once it is known. Without it a checker analyzes
 * against whatever interpreter the editor selected — an old one makes
 * `typing.TypeAlias` Unknown, which breaks every `Series[...]` annotation.
 */
function checkPythonVersionPinning(workdir: string): void {
  const configPath = path.join(workdir, 'pyrightconfig.json');
  const read = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  if (read().pythonVersion !== '3.11') {
    throw new Error(`fresh config did not pin the floor version: ${JSON.stringify(read())}`);
  }
  if (!ensurePyrightConfig(workdir, { pythonVersion: '3.14.0' })) {
    throw new Error('ensurePyrightConfig: pythonVersion was not reconciled');
  }
  if (read().pythonVersion !== '3.14') {
    throw new Error(`pythonVersion not narrowed to major.minor: ${JSON.stringify(read())}`);
  }
  if (ensurePyrightConfig(workdir, { pythonVersion: '3.14.2' })) {
    throw new Error('ensurePyrightConfig: rewrote the config for an unchanged major.minor');
  }
  log('pythonVersion pinning OK (3.11 floor -> 3.14 from the interpreter)');

  // A venv interpreter becomes venvPath/venv, so imports resolve from our
  // environment even when the editor has another interpreter selected.
  const envsDir = path.join(workdir, 'envs');
  const venvDir = path.join(envsDir, 'managed');
  fs.mkdirSync(path.join(venvDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(venvDir, 'pyvenv.cfg'), 'version = 3.14.0\n');
  if (!ensurePyrightConfig(workdir, { pythonBin: path.join(venvDir, 'bin', 'python') })) {
    throw new Error('ensurePyrightConfig: venvPath/venv were not written');
  }
  if (read().venvPath !== envsDir || read().venv !== 'managed') {
    throw new Error(`venv pair not derived from the interpreter: ${JSON.stringify(read())}`);
  }
  // A bare system interpreter has no venv to name; the stale pair must go
  // rather than leave pyright pointed at a parent directory.
  if (!ensurePyrightConfig(workdir, { pythonBin: '/usr/bin/python3' })) {
    throw new Error('ensurePyrightConfig: stale venv pair was not cleared');
  }
  if (read().venvPath !== undefined || read().venv !== undefined) {
    throw new Error(`non-venv interpreter left a venv pair: ${JSON.stringify(read())}`);
  }
  fs.rmSync(envsDir, { recursive: true, force: true });
  log('venvPath/venv OK (derived from a venv, cleared for a bare interpreter)');
}

/** L5c: rule restored, analyzer worker consulted, only real errors survive. */
async function checkPreciseFilter(serverModule: string): Promise<void> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-series-'));
  ensurePyrightConfig(workdir, { preciseIndexFilter: true });
  const written = JSON.parse(
    fs.readFileSync(path.join(workdir, 'pyrightconfig.json'), 'utf8')
  ) as Record<string, unknown>;
  if (written.reportIndexIssue !== 'error') {
    throw new Error(`preciseIndexFilter did not restore the rule: ${JSON.stringify(written)}`);
  }
  fs.mkdirSync(path.join(workdir, 'pynecore'), { recursive: true });
  fs.writeFileSync(path.join(workdir, 'pynecore', '__init__.py'), PYNECORE_STUB);
  fs.writeFileSync(path.join(workdir, 'pynecore', 'lib.py'), PYNECORE_LIB_STUB);
  const scriptPath = path.join(workdir, 'scripts', 'series.py');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, SERIES_SCRIPT);
  const scriptUri = pathToFileURL(scriptPath).toString();

  const diag = await diagnose(
    serverModule,
    workdir,
    scriptPath,
    scriptUri,
    SERIES_SCRIPT,
    (p) => p.diagnostics.filter((d) => d.code === 'reportIndexIssue').length >= 3
  );
  const indexDiags = diag.diagnostics.filter((d) => d.code === 'reportIndexIssue');
  if (indexDiags.length !== 3) {
    throw new Error(
      `expected 3 raw index diagnostics, got ${indexDiags.length}: ${JSON.stringify(diag.diagnostics)}`
    );
  }

  const spans = await analyzeSpans(SERIES_SCRIPT);
  const index = seriesSpanIndex(spans);
  const lines = SERIES_SCRIPT.split('\n');
  const kept = indexDiags.filter(
    (d) =>
      !isSeriesAccess(
        index,
        lines[d.range.start.line] ?? '',
        d.range.start.line,
        d.range.start.character,
        d.range.end.character
      )
  );
  if (kept.length !== 1 || !/scalar/.test(lines[kept[0].range.start.line] ?? '')) {
    throw new Error(
      `precise filter kept the wrong diagnostics: ${JSON.stringify(kept.map((d) => d.range))}`
    );
  }
  log(`Precise filter OK (3 raw index errors -> 1 real, spans: ${JSON.stringify(spans)})`);
  fs.rmSync(workdir, { recursive: true, force: true });
}

/**
 * Library exports are intentionally consumed by importers, so pyright's local
 * unused-function hint is dropped only for names the analyzer found through
 * `__all__` or `@export`; a genuinely dead helper stays visible.
 */
async function checkLibraryExports(serverModule: string): Promise<void> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-lib-'));
  ensurePyrightConfig(workdir, { preciseIndexFilter: true });
  const configPath = path.join(workdir, 'pyrightconfig.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  config.reportUnusedFunction = 'warning';
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const scriptPath = path.join(workdir, 'scripts', 'lib', 'me', 'probe', 'v1.py');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, LIB_SCRIPT);
  const scriptUri = pathToFileURL(scriptPath).toString();

  const diag = await diagnose(
    serverModule,
    workdir,
    scriptPath,
    scriptUri,
    LIB_SCRIPT,
    (p) => p.diagnostics.filter((d) => d.code === 'reportUnusedFunction').length >= 2
  );
  const unused = diag.diagnostics.filter((d) => d.code === 'reportUnusedFunction');
  if (unused.length !== 2) {
    throw new Error(
      `expected two raw unused-function diagnostics, got ${JSON.stringify(diag.diagnostics)}`
    );
  }

  const analysis = await analyzeSource(LIB_SCRIPT);
  const exports = seriesSpanIndex(analysis.exports);
  const kept = unused.filter(({ range }) => {
    const { start, end } = range;
    return (
      start.line !== end.line ||
      !isExactSpan(exports, start.line, start.character, end.character)
    );
  });
  if (
    kept.length !== 1 ||
    LIB_SCRIPT.split('\n')[kept[0].range.start.line] !== '    def helper() -> int:'
  ) {
    throw new Error(
      `library export filter kept the wrong diagnostics: ${JSON.stringify(kept)}`
    );
  }
  log('Library exports OK (public function suppressed, unused helper kept)');
  fs.rmSync(workdir, { recursive: true, force: true });
}

/** Drive the real analyzer worker over one source and return its spans. */
async function analyzeSpans(source: string): Promise<Span[]> {
  return (await analyzeSource(source)).spans;
}

/** Drive the real analyzer worker over one source. */
function analyzeSource(source: string): Promise<{ spans: Span[]; exports: Span[] }> {
  const script = path.resolve('python/pyneide_series.py');
  return new Promise((resolve, reject) => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const worker = spawn(python, ['-u', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      worker.kill();
      reject(new Error('series analyzer timed out'));
    }, 20000);
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', (chunk: string) => {
      out += chunk;
      const newline = out.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      worker.kill();
      const response = JSON.parse(out.slice(0, newline)) as {
        ok?: boolean;
        spans?: Span[];
        exports?: Span[];
      };
      if (!response.ok) reject(new Error(`series analyzer failed: ${out.slice(0, newline)}`));
      else resolve({ spans: response.spans ?? [], exports: response.exports ?? [] });
    });
    worker.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    worker.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`series analyzer could not start (${python}): ${e.message}${err}`));
    });
    worker.stdin.write(JSON.stringify({ id: 1, source }) + '\n');
  });
}

/** Open one document on a fresh server and return the first matching publish. */
async function diagnose(
  serverModule: string,
  workdir: string,
  scriptPath: string,
  scriptUri: string,
  text: string,
  ready: (params: PublishParams) => boolean
): Promise<PublishParams> {
  const lsp = new LspStdio(process.execPath, [serverModule, '--stdio']);
  // workspaceFolders is what makes pyright 1.1.411 register the workspace and
  // load its pyrightconfig.json — a bare rootUri lands in the configless
  // "<default>" service instance (VSCode's client always sends folders).
  const init = (await lsp.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(workdir).toString(),
    workspaceFolders: [{ uri: pathToFileURL(workdir).toString(), name: 'smoke' }],
    capabilities: {},
  })) as { capabilities?: { textDocumentSync?: unknown } };
  if (!init.capabilities?.textDocumentSync) {
    throw new Error(`lsp: missing capabilities: ${JSON.stringify(init)}`);
  }
  lsp.notify('initialized', {});

  // The analyzed publish is the one carrying the intended diagnostics; interim
  // (e.g. empty first-pass) publishes are skipped by the predicate.
  const analyzed = lsp.waitForNotification('textDocument/publishDiagnostics', 60000, (params) => {
    const p = params as PublishParams;
    return p.uri === scriptUri && ready(p);
  });
  lsp.notify('textDocument/didOpen', {
    textDocument: { uri: scriptUri, languageId: 'python', version: 1, text },
  });
  const diag = (await analyzed) as PublishParams;

  await lsp.request('shutdown');
  lsp.notify('exit');
  const code = await lsp.exited();
  if (code !== 0) throw new Error(`lsp: exit code ${code}`);
  return diag;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
