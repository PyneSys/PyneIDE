import * as fs from 'node:fs/promises';

import * as vscode from 'vscode';

import { DETECT_HEAD_BYTES, detectPyne, isPythonSyntax } from './pyneDetect';

/** Prefer the editor buffer so unsaved changes to the Pyne marker count. */
export async function readPyneSourceHead(uri: vscode.Uri): Promise<string> {
  const key = uri.toString();
  const open = vscode.workspace.textDocuments.find((doc) => !doc.isClosed && doc.uri.toString() === key);
  if (open) return open.getText().slice(0, DETECT_HEAD_BYTES);

  if (uri.scheme !== 'file') {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes.subarray(0, DETECT_HEAD_BYTES)).toString('utf8');
  }

  const handle = await fs.open(uri.fsPath, 'r');
  try {
    const buffer = Buffer.alloc(DETECT_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Keep Pyne code out of the Python extension's run/debug menus and providers. */
export function registerPyneLanguage(context: vscode.ExtensionContext): void {
  const pending = new Set<string>();
  let disposed = false;

  const reconcile = async (document: vscode.TextDocument): Promise<void> => {
    if (disposed || document.isClosed || !isPythonSyntax(document.languageId)) return;
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return;
    const key = document.uri.toString();
    if (pending.has(key)) return;
    const language = detectPyne(document.getText().slice(0, DETECT_HEAD_BYTES))
      ? 'pyne' : 'python';
    if (document.languageId === language) return;

    pending.add(key);
    try {
      // VS Code closes and reopens the document when changing its language.
      const updated = await vscode.languages.setTextDocumentLanguage(document, language);
      pending.delete(key);
      // The marker may have changed while the language switch was in flight.
      await reconcile(updated);
    } catch (error) {
      console.error('PyneIDE: could not set document language', error);
    } finally {
      pending.delete(key);
    }
  };

  context.subscriptions.push(
    { dispose: () => { disposed = true; } },
    vscode.workspace.onDidOpenTextDocument((document) => void reconcile(document)),
    vscode.workspace.onDidChangeTextDocument((event) => void reconcile(event.document))
  );
  for (const document of vscode.workspace.textDocuments) void reconcile(document);
}
