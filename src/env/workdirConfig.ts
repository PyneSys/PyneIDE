import * as vscode from 'vscode';

import { hasGeneratedPyrightConfig, resolveWorkdir, type WorkdirResolution } from './workdir';

/**
 * The workspace's workdir, but only when PyneIDE set it up itself (its
 * generated `pyrightconfig.json` is there). Everything that writes into the
 * user's project or overrides another extension goes through this, never
 * through the bare workdir resolution: the name-based search walks up to ten
 * parent directories, so one `workdir` folder high up would otherwise claim
 * every plain Python project below it.
 */
export function resolvePyneIdeWorkdir(
  folder?: vscode.WorkspaceFolder
): WorkdirResolution | undefined {
  const workdir = resolveWorkspaceWorkdir(folder);
  if (!workdir?.exists || !hasGeneratedPyrightConfig(workdir.path)) return undefined;
  return workdir;
}

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
