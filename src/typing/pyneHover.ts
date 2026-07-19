import * as vscode from 'vscode';

import { detectPyne, DETECT_HEAD_BYTES } from '../pyneDetect';
import type { SeriesAnalyzer } from './seriesAnalyzer';

/**
 * Standalone hover for the declared Pyne type of `Series`/`Persistent`
 * variables (F7/L5c hover cosmetics, Pylance edition).
 *
 * When the bundled pyright runs, its LSP middleware rewrites the checker's
 * hover in place — one clean hover, `Literal[1]` replaced by the declared
 * `Persistent[float]`. When a superseding extension (Pylance/pyright/
 * basedpyright) provides Python analysis instead, there is no middleware to
 * rewrite through: another extension's hover cannot be modified, only
 * supplemented. This provider adds the declared Pyne type as its own hover
 * entry, which VSCode stacks alongside Pylance's.
 *
 * `active` gates on the bundled client: while our own middleware serves, this
 * provider stays silent so the type does not appear twice.
 */
export class PyneHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly analyzer: SeriesAnalyzer,
    /** Whether the bundled pyright middleware already decorates hovers. */
    private readonly superseded: () => boolean
  ) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.languages.registerHoverProvider({ scheme: 'file', language: 'python' }, this)
    );
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    if (!this.superseded()) return undefined;
    if (detectPyne(document.getText().slice(0, DETECT_HEAD_BYTES)) === undefined) {
      return undefined;
    }
    const text = document.getText();
    const analysis = this.analyzer.cached(document.uri, text);
    if (!analysis) {
      // Warm the cache for the next hover; providers must answer promptly and
      // a missing first hover is invisible next to Pylance's own.
      void this.analyzer.analyze(document.uri, text);
      return undefined;
    }
    const ref = analysis.refs.find(
      (r) =>
        r.line === position.line && r.start <= position.character && position.character < r.end
    );
    if (!ref) return undefined;
    const name = document.getText(
      new vscode.Range(ref.line, ref.start, ref.line, ref.end)
    );
    const markdown = new vscode.MarkdownString();
    markdown.appendCodeblock(`${name}: ${ref.annotation}`, 'python');
    return new vscode.Hover(
      markdown,
      new vscode.Range(ref.line, ref.start, ref.line, ref.end)
    );
  }
}
