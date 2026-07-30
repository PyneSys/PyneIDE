/**
 * The in-IDE help entry point: `PyneIDE: Documentation`.
 *
 * There is no single documentation page to link to — the extension's own docs
 * live in the repository README, while everything about the language and the
 * runtime semantics belongs to PyneCore. A quickpick names both rather than
 * picking one and hiding the other, and it doubles as the "about" surface the
 * report flow needs (which version am I running).
 */
import * as vscode from 'vscode';

const DOCS_URL = 'https://github.com/PyneSys/PyneIDE#readme';
const PYNECORE_DOCS_URL = 'https://pynecore.org/docs';
const ISSUES_URL = 'https://github.com/PyneSys/PyneIDE/issues';

type HelpItem = vscode.QuickPickItem & { action: () => void };

export function registerHelpCommands(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('pyneide.openDocs', async () => {
    const open = (url: string) => () => void vscode.env.openExternal(vscode.Uri.parse(url));
    const items: HelpItem[] = [
      {
        label: '$(book) PyneIDE Documentation',
        description: 'Features, setup and settings',
        detail: DOCS_URL,
        action: open(DOCS_URL),
      },
      {
        label: '$(library) PyneCore Documentation',
        description: 'The Pine-compatible runtime: language semantics and APIs',
        detail: PYNECORE_DOCS_URL,
        action: open(PYNECORE_DOCS_URL),
      },
      {
        label: '$(rocket) Get Started',
        description: 'The seven-step walkthrough inside the IDE',
        action: () => void vscode.commands.executeCommand('pyneide.openWalkthrough'),
      },
      {
        label: '$(report) Report a Problem…',
        description: 'Send an error report to the PyneIDE author',
        action: () => void vscode.commands.executeCommand('pyneide.reportProblem'),
      },
      {
        label: '$(issues) Issue Tracker',
        description: 'Browse known problems and feature requests',
        detail: ISSUES_URL,
        action: open(ISSUES_URL),
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `PyneIDE ${context.extension.packageJSON.version as string}`,
      placeHolder: 'Type to filter help topics',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    picked?.action();
  });
}
