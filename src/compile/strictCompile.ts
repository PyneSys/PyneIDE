import * as vscode from 'vscode';

/** Effective `pyneide.strictCompile` for a resource (defaults to the active editor). */
export function isStrictCompile(uri?: vscode.Uri): boolean {
  return vscode.workspace
    .getConfiguration('pyneide', uri)
    .get<boolean>('strictCompile', false);
}

/**
 * Register the strict-compile toggle command (surfaced in the PyneIDE status
 * bar menu and the Command Palette). Flipping it only rewrites the setting —
 * the compile cache keys on the strict flag, so the next Run/Debug recompiles
 * the script in the new mode by itself.
 */
export function registerStrictCompileToggle(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('pyneide.toggleStrictCompile', async () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      const next = !isStrictCompile(uri);
      const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await vscode.workspace
        .getConfiguration('pyneide', uri)
        .update('strictCompile', next, target);
      void vscode.window.showInformationMessage(
        next
          ? 'PyneIDE: strict compilation ON — the next run or debug recompiles the script.'
          : 'PyneIDE: strict compilation OFF — the next run or debug recompiles the script.'
      );
    })
  );
}
