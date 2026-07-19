import * as vscode from 'vscode';

import { DETECT_HEAD_BYTES, findEdgeToken } from '../pyneDetect';

/**
 * Quick fix on `pyne-edge-*` diagnostics: "Convert to full @pyne" — deletes
 * the ` edge` token from the head docstring, so leaving the Edge profile is a
 * deliberate, labelled, one-click decision instead of a fight with the
 * fail-closed linter. The wording spells out the trade-off (Edge is the
 * web/bot portability promise); the actual re-check happens naturally when
 * the checker re-runs on the edit.
 */
export class EdgeQuickFixProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        { language: 'python' },
        this,
        EdgeQuickFixProvider.metadata
      )
    );
  }

  provideCodeActions(
    doc: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] | undefined {
    const edgeDiagnostics = context.diagnostics.filter(
      (d) => d.source === 'Pyne' && typeof d.code === 'string' && d.code.startsWith('pyne-edge-')
    );
    if (edgeDiagnostics.length === 0) {
      return undefined;
    }
    const token = findEdgeToken(doc.getText().slice(0, DETECT_HEAD_BYTES));
    if (!token) {
      return undefined;
    }
    const action = new vscode.CodeAction(
      'Convert to full @pyne (removes web/bot compatibility)',
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = edgeDiagnostics;
    action.edit = new vscode.WorkspaceEdit();
    action.edit.delete(
      doc.uri,
      new vscode.Range(doc.positionAt(token.start), doc.positionAt(token.end))
    );
    return [action];
  }
}
