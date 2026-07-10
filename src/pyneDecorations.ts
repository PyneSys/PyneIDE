import * as fsp from 'node:fs/promises';
import * as vscode from 'vscode';
import { DETECT_HEAD_BYTES, detectPyne, type PyneKind } from './pyneDetect';

/**
 * Explorer/tab badge for Pyne scripts: `.py` files whose docstring starts
 * with `@pyne` get a "Py" badge, `@pyne edge` scripts a "PE" badge.
 */
export class PyneDecorationProvider implements vscode.FileDecorationProvider {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.changeEmitter.event;

  /** uri -> detection result, invalidated on document change/save. */
  private readonly cache = new Map<string, PyneKind | undefined>();

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerFileDecorationProvider(this),
      this.changeEmitter,
      vscode.workspace.onDidChangeTextDocument(e => this.invalidate(e.document)),
      vscode.workspace.onDidOpenTextDocument(d => this.invalidate(d)),
    );
  }

  private invalidate(document: vscode.TextDocument): void {
    if (!document.fileName.endsWith('.py')) {
      return;
    }
    const key = document.uri.toString();
    const previous = this.cache.get(key);
    const current = detectPyne(document.getText().slice(0, DETECT_HEAD_BYTES));
    if (!this.cache.has(key) || previous !== current) {
      this.cache.set(key, current);
      this.changeEmitter.fire(document.uri);
    }
  }

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (!uri.path.endsWith('.py')) {
      return undefined;
    }
    const key = uri.toString();
    let kind = this.cache.get(key);
    if (!this.cache.has(key)) {
      kind = detectPyne(await readHead(uri));
      this.cache.set(key, kind);
    }
    if (kind === undefined) {
      return undefined;
    }
    return kind === 'edge'
      ? new vscode.FileDecoration('PE', 'Pyne Edge script', new vscode.ThemeColor('charts.purple'))
      : new vscode.FileDecoration('Py', 'Pyne script', new vscode.ThemeColor('charts.green'));
  }
}

/** Read only the head of the file — enough for docstring detection. */
async function readHead(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
  if (open !== undefined) {
    return open.getText().slice(0, DETECT_HEAD_BYTES);
  }
  if (uri.scheme === 'file') {
    const handle = await fsp.open(uri.fsPath, 'r');
    try {
      const buffer = Buffer.alloc(DETECT_HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, DETECT_HEAD_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }
  // Remote/virtual schemes: no partial read available, take the whole file.
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes.subarray(0, DETECT_HEAD_BYTES)).toString('utf8');
}
