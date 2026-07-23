/**
 * Source-first chart breakpoints.
 *
 * The VSCode SourceBreakpoint remains the single source of truth. PyneIDE only
 * appends a deliberately recognizable time clause to its condition, then the
 * chart renders those timestamps as visual markers. This preserves VSCode's
 * native Breakpoints view, enable/disable state, persistence and source-line
 * tracking instead of maintaining a second breakpoint database.
 */
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { ChartBreakpointTarget } from '../chart/messages';
import { canonicalChartKey } from '../chart/chartKey';
import type { ChartManager } from '../chart/chartPanel';
import {
  addChartTimestamp,
  removeChartTimestamp,
  splitChartCondition,
} from './chartBreakpointCondition';

interface PendingSelection {
  breakpointId: string;
  chartKey: string;
}

/** `editor/lineNumber/context` forwards one object, not positional arguments. */
interface LineNumberContextArg {
  uri: vscode.Uri;
  /** Monaco editor line numbers are one-based. */
  lineNumber: number;
}

function isLineNumberContextArg(value: unknown): value is LineNumberContextArg {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { uri?: unknown; lineNumber?: unknown };
  return candidate.uri instanceof vscode.Uri && Number.isInteger(candidate.lineNumber);
}

function sourceBreakpointAt(uri: vscode.Uri, line: number): vscode.SourceBreakpoint | undefined {
  return vscode.debug.breakpoints.find(
    (bp): bp is vscode.SourceBreakpoint =>
      bp instanceof vscode.SourceBreakpoint &&
      sameUri(bp.location.uri, uri) &&
      bp.location.range.start.line === line
  );
}

function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  if (a.scheme !== b.scheme) return false;
  if (a.scheme !== 'file') return a.toString() === b.toString();
  const left = path.resolve(a.fsPath);
  const right = path.resolve(b.fsPath);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function replaceBreakpoint(
  bp: vscode.SourceBreakpoint,
  condition: string | undefined
): vscode.SourceBreakpoint {
  return new vscode.SourceBreakpoint(
    bp.location,
    bp.enabled,
    condition,
    bp.hitCondition,
    bp.logMessage
  );
}

export class ChartBreakpointService {
  private pending: PendingSelection | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly charts: ChartManager
  ) {}

  register(): void {
    this.charts.breakpointTargetsForChart = (chartKey) => this.targetsForChart(chartKey);
    this.charts.onSelectBreakpointBar = (chartKey, timestamp) =>
      this.acceptBar(chartKey, timestamp);
    this.charts.onRemoveBreakpointBar = (chartKey, timestamp) =>
      this.removeTimestamp(chartKey, timestamp);
    this.charts.onCancelBreakpointSelection = (chartKey) => this.cancelSelection(chartKey);

    this.context.subscriptions.push(
      vscode.commands.registerCommand(
        'pyneide.selectBreakpointBar',
        (arg?: vscode.Uri | LineNumberContextArg, lineNumber?: number) =>
          this.selectFromSource(arg, lineNumber)
      ),
      vscode.debug.onDidChangeBreakpoints((event) => {
        if (this.pending && event.removed.some((bp) => bp.id === this.pending?.breakpointId)) {
          this.cancelSelection(this.pending.chartKey);
        }
        this.charts.refreshBreakpointTargets();
      })
    );
    this.charts.refreshBreakpointTargets();
  }

  private async selectFromSource(
    arg?: vscode.Uri | LineNumberContextArg,
    legacyLineNumber?: number
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const contextArg = isLineNumberContextArg(arg) ? arg : undefined;
    const uri = contextArg?.uri ?? (arg instanceof vscode.Uri ? arg : editor?.document.uri);
    if (!uri || !/\.(?:pine|py)$/i.test(uri.fsPath)) {
      void vscode.window.showWarningMessage(
        'PyneIDE: open a Pyne (.py) or Pine (.pine) source file first.'
      );
      return;
    }

    const suppliedLineNumber = contextArg?.lineNumber ?? legacyLineNumber;
    const line = Number.isInteger(suppliedLineNumber)
      ? Math.max(0, suppliedLineNumber! - 1)
      : editor && sameUri(editor.document.uri, uri)
        ? editor.selection.active.line
        : undefined;
    if (line === undefined) {
      void vscode.window.showWarningMessage('PyneIDE: could not determine the source line.');
      return;
    }

    let breakpoint = sourceBreakpointAt(uri, line);
    if (!breakpoint) {
      breakpoint = new vscode.SourceBreakpoint(
        new vscode.Location(uri, new vscode.Position(line, 0))
      );
      vscode.debug.addBreakpoints([breakpoint]);
    }
    if (breakpoint.logMessage) {
      void vscode.window.showWarningMessage(
        'PyneIDE: chart bar binding is available for stopping breakpoints, not logpoints.'
      );
      return;
    }

    this.cancelSelection();
    const chartKey = canonicalChartKey(uri.fsPath);
    if (this.charts.hasOpenChart(chartKey)) {
      // Preserve the live webview state (scroll/zoom/crosshair). The regular
      // Open Chart command intentionally reloads persisted output while idle.
      this.charts.reveal(chartKey);
    } else {
      await vscode.commands.executeCommand('pyneide.openChart', uri);
    }
    if (!vscode.debug.breakpoints.some((bp) => bp.id === breakpoint.id)) return;

    const label = `${path.basename(uri.fsPath)}:${line + 1}`;
    if (!this.charts.beginBreakpointSelection(chartKey, label)) {
      void vscode.window.showWarningMessage(
        'PyneIDE: the chart could not be opened, so no bar was selected.'
      );
      return;
    }
    this.pending = { breakpointId: breakpoint.id, chartKey };
  }

  private acceptBar(chartKey: string, timestamp: number): void {
    const pending = this.pending;
    if (
      !pending ||
      pending.chartKey !== chartKey ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0
    ) return;
    const breakpoint = vscode.debug.breakpoints.find(
      (bp): bp is vscode.SourceBreakpoint =>
        bp instanceof vscode.SourceBreakpoint && bp.id === pending.breakpointId
    );
    this.pending = undefined;
    this.charts.endBreakpointSelection(chartKey);
    if (!breakpoint) return;

    const replacement = replaceBreakpoint(
      breakpoint,
      addChartTimestamp(breakpoint.condition, timestamp)
    );
    vscode.debug.removeBreakpoints([breakpoint]);
    vscode.debug.addBreakpoints([replacement]);
    this.charts.refreshBreakpointTargets();
  }

  private cancelSelection(chartKey?: string): void {
    if (chartKey && this.pending?.chartKey !== chartKey) return;
    const key = this.pending?.chartKey;
    this.pending = undefined;
    if (key) this.charts.endBreakpointSelection(key);
    else this.charts.endBreakpointSelection();
  }

  removeTimestamp(chartKey: string, timestamp: number): void {
    const removals: vscode.SourceBreakpoint[] = [];
    const additions: vscode.SourceBreakpoint[] = [];
    for (const bp of this.sourceBreakpointsForChart(chartKey)) {
      if (!splitChartCondition(bp.condition).timestamps.includes(timestamp)) continue;
      removals.push(bp);
      const condition = removeChartTimestamp(bp.condition, timestamp);
      // With no user-authored base condition and no chart timestamps left,
      // the breakpoint itself has no remaining purpose. A base condition,
      // however, must survive as a normal native source breakpoint.
      if (condition !== undefined) additions.push(replaceBreakpoint(bp, condition));
    }
    if (!removals.length) return;
    vscode.debug.removeBreakpoints(removals);
    if (additions.length) vscode.debug.addBreakpoints(additions);
    this.charts.refreshBreakpointTargets();
  }

  private targetsForChart(chartKey: string): ChartBreakpointTarget[] {
    const targets = new Map<number, ChartBreakpointTarget>();
    for (const bp of this.sourceBreakpointsForChart(chartKey)) {
      for (const timestamp of splitChartCondition(bp.condition).timestamps) {
        const current = targets.get(timestamp);
        if (current) {
          current.count++;
          current.enabled ||= bp.enabled;
        } else {
          targets.set(timestamp, { timestamp, enabled: bp.enabled, count: 1 });
        }
      }
    }
    return [...targets.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  private sourceBreakpointsForChart(chartKey: string): vscode.SourceBreakpoint[] {
    return vscode.debug.breakpoints.filter(
      (bp): bp is vscode.SourceBreakpoint =>
        bp instanceof vscode.SourceBreakpoint &&
        !bp.logMessage &&
        /\.(?:pine|py)$/i.test(bp.location.uri.fsPath) &&
        canonicalChartKey(bp.location.uri.fsPath) === chartKey
    );
  }
}
