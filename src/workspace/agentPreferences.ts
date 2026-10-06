import * as path from 'node:path';

import * as vscode from 'vscode';

import { agentFileExcludes } from '../env/workdir';
import { resolvePyneIdeWorkdir } from '../env/workdirConfig';
import { AGENT_RULES_FILE, ensureAgentRulesFile } from './agentSkills';

export function agentProjectFolder(): vscode.WorkspaceFolder | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const active = uri && vscode.workspace.getWorkspaceFolder(uri);
  if (active && resolvePyneIdeWorkdir(active)) return active;
  return vscode.workspace.workspaceFolders?.find((folder) => resolvePyneIdeWorkdir(folder));
}

function hasExplicitVisibility(config: vscode.WorkspaceConfiguration): boolean {
  const value = config.inspect<boolean>('showAgentFiles');
  return value?.workspaceFolderValue !== undefined || value?.workspaceValue !== undefined ||
    value?.globalValue !== undefined;
}

async function updateVisibility(folder: vscode.WorkspaceFolder): Promise<void> {
  if (!resolvePyneIdeWorkdir(folder)) return;
  const config = vscode.workspace.getConfiguration('pyneide', folder.uri);
  const files = vscode.workspace.getConfiguration('files', folder.uri);
  const inspected = files.inspect<Record<string, unknown>>('exclude');
  const current = inspected?.workspaceFolderValue ??
    (vscode.workspace.workspaceFolders?.length === 1 ? inspected?.workspaceValue : undefined) ?? {};
  const next = agentFileExcludes(current, files.get('exclude', {}),
    config.get<boolean>('showAgentFiles', false), hasExplicitVisibility(config));
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    await files.update('exclude', next, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

export function registerAgentPreferences(
  context: vscode.ExtensionContext,
  log: (message: string) => void
): void {
  let pending = Promise.resolve();
  const refresh = (): void => {
    pending = pending.then(async () => {
      for (const folder of vscode.workspace.workspaceFolders ?? []) await updateVisibility(folder);
    }).catch((error: unknown) => log(`Agent file visibility: ${String(error)}`));
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('pyneide.editAgentRules', async () => {
      const folder = agentProjectFolder();
      if (!folder) {
        void vscode.window.showWarningMessage('PyneIDE: initialize a Pyne project before editing development preferences.');
        return;
      }
      ensureAgentRulesFile(folder.uri.fsPath, context.extensionPath);
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(folder.uri.fsPath, AGENT_RULES_FILE))
      );
      await vscode.window.showTextDocument(document, { preview: false });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('pyneide.showAgentFiles')) void refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh())
  );
  void refresh();
}
