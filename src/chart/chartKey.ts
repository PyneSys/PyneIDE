/**
 * Chart identity and lifetime.
 *
 * A Pine script (`foo.pine`) and its compiled output (`foo.py`, same directory
 * and stem) are ONE logical chart, keyed by the `.pine`. A hand-written `@pyne`
 * `.py` with no `.pine` sibling keys on itself. The chart lives as long as
 * EITHER file is open in an editor tab (or a run/debug is streaming to it) —
 * see `ChartManager.reconcile`. This is why the chart key is canonicalized
 * everywhere a run/preview/data-binding is scoped to a script.
 */
import * as fs from 'node:fs';

import * as vscode from 'vscode';

/** Only `.pine` and `.py` files can own a chart. */
export function isChartablePath(fsPath: string): boolean {
  return fsPath.endsWith('.pine') || fsPath.endsWith('.py');
}

/**
 * Map a script's source path to its canonical chart key: a compiled `.py` folds
 * onto its sibling `.pine` (so running/debugging either shares one chart);
 * everything else keys on itself.
 */
export function canonicalChartKey(fsPath: string): string {
  if (fsPath.endsWith('.py')) {
    const pine = `${fsPath.slice(0, -'.py'.length)}.pine`;
    if (fs.existsSync(pine)) return pine;
  }
  return fsPath;
}

/**
 * The canonical chart keys currently backed by an open editor tab (either the
 * `.pine` or its compiled `.py` counts). The chart's own webview tab is not a
 * text tab, so a chart never keeps itself alive.
 */
export function openChartKeys(): Set<string> {
  const keys = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      const uri =
        input instanceof vscode.TabInputText
          ? input.uri
          : input instanceof vscode.TabInputTextDiff
            ? input.modified
            : undefined;
      if (uri && uri.scheme === 'file' && isChartablePath(uri.fsPath)) {
        keys.add(canonicalChartKey(uri.fsPath));
      }
    }
  }
  return keys;
}
