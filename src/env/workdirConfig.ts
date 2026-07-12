import * as vscode from 'vscode';

import { resolveWorkdir, type WorkdirResolution } from './workdir';

/**
 * Resolve the workdir for a workspace folder, honoring the `pyneide.workdir`
 * setting (resource-scoped; "." marks the folder itself as the workdir).
 */
export function resolveWorkspaceWorkdir(
  folder?: vscode.WorkspaceFolder,
  scriptDir?: string
): WorkdirResolution | undefined {
  const ws = folder ?? vscode.workspace.workspaceFolders?.[0];
  const setting = vscode.workspace.getConfiguration('pyneide', ws?.uri).get<string>('workdir');
  return resolveWorkdir({ setting, wsFolder: ws?.uri.fsPath, scriptDir });
}
