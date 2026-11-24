import * as path from 'node:path';

import * as vscode from 'vscode';

import { DETECT_HEAD_BYTES, detectPyne } from './pyneDetect';
import { readPyneSourceHead } from './pyneLanguage';

function counterparts(document: vscode.TextDocument): string[] {
  if (document.uri.scheme !== 'file') return [];

  const file = document.uri.fsPath;
  const extension = path.extname(file).toLowerCase();
  const stem = file.slice(0, -extension.length);
  if (extension === '.pine') return [`${stem}.pyne`, `${stem}.py`];
  if (extension === '.pyne' ||
      (extension === '.py' && detectPyne(document.getText().slice(0, DETECT_HEAD_BYTES)))) {
    return [`${stem}.pine`];
  }
  return [];
}

async function findCounterpart(candidates: string[]): Promise<vscode.Uri | undefined> {
  for (const candidate of candidates) {
    const uri = vscode.Uri.file(candidate);
    try {
      const { type } = await vscode.workspace.fs.stat(uri);
      if (!(type & vscode.FileType.File)) continue;
      if (!candidate.endsWith('.py') || detectPyne(await readPyneSourceHead(uri))) return uri;
    } catch {
      // A sibling can disappear between its filesystem event and the read.
    }
  }
  return undefined;
}

export function registerScriptPairSwitch(context: vscode.ExtensionContext): void {
  let candidates: string[] = [];
  let directory: string | undefined;
  let watcher: vscode.FileSystemWatcher | undefined;
  let revision = 0;

  const refresh = async (): Promise<void> => {
    const currentRevision = ++revision;
    const document = vscode.window.activeTextEditor?.document;
    candidates = document ? counterparts(document) : [];

    const nextDirectory = candidates.length ? path.dirname(candidates[0]) : undefined;
    if (nextDirectory !== directory) {
      watcher?.dispose();
      directory = nextDirectory;
      watcher = directory ? vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(directory, '*.{pine,pyne,py}')
      ) : undefined;
      const onFileEvent = (uri: vscode.Uri): void => {
        if (candidates.includes(uri.fsPath)) void refresh();
      };
      watcher?.onDidCreate(onFileEvent);
      watcher?.onDidChange(onFileEvent);
      watcher?.onDidDelete(onFileEvent);
    }

    const counterpart = await findCounterpart(candidates);
    if (currentRevision === revision) {
      await vscode.commands.executeCommand(
        'setContext', 'pyneide.pairedScriptResources', counterpart && document ? [document.uri.toString()] : []
      );
    }
  };

  const onPythonDocument = (document: vscode.TextDocument): void => {
    if (document.uri.scheme !== 'file' || !/\.py$/i.test(document.uri.fsPath)) return;
    if (document === vscode.window.activeTextEditor?.document || candidates.includes(document.uri.fsPath)) {
      void refresh();
    }
  };

  const switchTo = async (language: 'pine' | 'pyne'): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const target = await findCounterpart(counterparts(editor.document));
    if (!target || (target.fsPath.endsWith('.pine') ? 'pine' : 'pyne') !== language ||
        vscode.window.activeTextEditor !== editor) return;
    try {
      await vscode.window.showTextDocument(target, { viewColumn: editor.viewColumn, preview: false });
    } catch (error) {
      void vscode.window.showWarningMessage(`PyneIDE: could not open ${path.basename(target.fsPath)}. ${error}`);
      void refresh();
    }
  };

  context.subscriptions.push(
    { dispose: () => { revision++; watcher?.dispose(); } },
    vscode.commands.registerCommand('pyneide.switchToPine', () => switchTo('pine')),
    vscode.commands.registerCommand('pyneide.switchToPyne', () => switchTo('pyne')),
    vscode.window.onDidChangeActiveTextEditor(() => void refresh()),
    vscode.workspace.onDidOpenTextDocument(onPythonDocument),
    vscode.workspace.onDidCloseTextDocument(onPythonDocument),
    vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      if (contentChanges.some(({ rangeOffset }) => rangeOffset < DETECT_HEAD_BYTES)) onPythonDocument(document);
    })
  );
  void refresh();
}
