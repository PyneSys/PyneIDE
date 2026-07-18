/**
 * Bundled pyright smoke test — runs WITHOUT VSCode against the pyright copy
 * shipped in dist/pyright, driving it exactly like the extension does (LSP)
 * over a workspace produced by the real ensurePyrightConfig() generator.
 * Verifies the L5a/L5b contract:
 *  - the bundled server starts on plain Node and speaks LSP;
 *  - real type errors are reported (reportAssignmentType);
 *  - reportIndexIssue is silenced by the generated pyrightconfig.json
 *    (series history indexing noise under the transparent Series alias).
 * Usage: node dist/pyright-smoke.js
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ensurePyrightConfig } from '../../src/env/workdir';
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

interface PublishParams {
  uri: string;
  diagnostics: { code?: unknown; message: string; severity?: number }[];
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
  const scriptPath = path.join(workdir, 'scripts', 'demo.py');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, PYNE_SCRIPT);
  const scriptUri = pathToFileURL(scriptPath).toString();
  log(`Workspace: ${workdir}`);

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

  // The analyzed publish is the one carrying the intended type error; interim
  // (e.g. empty first-pass) publishes are skipped by the predicate.
  const analyzed = lsp.waitForNotification('textDocument/publishDiagnostics', 60000, (params) => {
    const p = params as PublishParams;
    return p.uri === scriptUri && p.diagnostics.some((d) => d.code === 'reportAssignmentType');
  });
  lsp.notify('textDocument/didOpen', {
    textDocument: { uri: scriptUri, languageId: 'python', version: 1, text: PYNE_SCRIPT },
  });
  const diag = (await analyzed) as PublishParams;

  const rules = diag.diagnostics.map((d) => d.code).filter(Boolean);
  if (rules.includes('reportIndexIssue')) {
    throw new Error(
      `generated config did not silence reportIndexIssue: ${JSON.stringify(diag.diagnostics)}`
    );
  }
  log(`Diagnostics OK (${diag.diagnostics.length} total, rules: ${rules.join(', ')})`);

  await lsp.request('shutdown');
  lsp.notify('exit');
  const code = await lsp.exited();
  if (code !== 0) throw new Error(`lsp: exit code ${code}`);

  fs.rmSync(workdir, { recursive: true, force: true });
  log('PYRIGHT SMOKE OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
