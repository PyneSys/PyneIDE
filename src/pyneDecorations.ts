import * as vscode from 'vscode';
import { DETECT_HEAD_BYTES, detectPyne, type PyneKind } from './pyneDetect';
import { readPyneSourceHead } from './pyneLanguage';

/**
 * Explorer/tab badge for Pyne scripts: `.py` files whose docstring starts
 * with `@pyne` get an evergreen badge, `@pyne edge` scripts an evergreen + e
 * one. VSCode allows at most two grapheme clusters in a badge, so the
 * surrogate-pair emoji plus a single letter is exactly at the limit. No
 * decoration color: in the Explorer that channel already carries git and
 * language-server state, and a second meaning for it only confuses.
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
      kind = detectPyne(await readPyneSourceHead(uri));
      this.cache.set(key, kind);
    }
    if (kind === undefined) {
      return undefined;
    }
    if (kind === 'edge') {
      return new vscode.FileDecoration('\u{1F332}e', 'Pyne Edge script');
    }
    if (kind === 'lib') {
      return new vscode.FileDecoration('\u{1F332}l', 'Pyne library module');
    }
    return new vscode.FileDecoration('\u{1F332}', 'Pyne script');
  }
}
