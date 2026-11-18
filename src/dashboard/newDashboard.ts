/**
 * `PyneIDE: New Dashboard…`: name a dashboard, write its empty file into the
 * workdir's `dashboards/` folder, and open it in the dashboard editor.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import { DASHBOARDS_DIR } from '../workspace/tree';
import { DashboardEditorProvider } from './dashboardEditor';
import { emptyDashboard, serializeDashboard } from './model';

/** A dashboard name that is also a file name on every platform. */
const NAME_RE = /^[^\\/:*?"<>|]+$/;

export async function newDashboard(): Promise<void> {
  const workdir = resolveWorkspaceWorkdir();
  if (!workdir?.exists) {
    void vscode.window.showWarningMessage('PyneIDE: no Pyne workspace found — initialize one first.');
    return;
  }
  const dir = path.join(workdir.path, DASHBOARDS_DIR);
  const name = await vscode.window.showInputBox({
    title: 'New Dashboard',
    prompt: 'The dashboard\'s name; it is also its file name in the dashboards folder',
    placeHolder: 'BTC scalping',
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return 'Give the dashboard a name';
      if (!NAME_RE.test(trimmed) || trimmed.startsWith('.')) return 'A name cannot hold \\ / : * ? " < > |';
      if (fs.existsSync(path.join(dir, `${trimmed}.toml`))) return 'A dashboard of this name exists';
      return undefined;
    },
  });
  if (name === undefined) return;
  const file = path.join(dir, `${name.trim()}.toml`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, serializeDashboard(emptyDashboard(name.trim())), { encoding: 'utf8', flag: 'wx' });
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), DashboardEditorProvider.viewType);
}
