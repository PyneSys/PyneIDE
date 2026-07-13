/**
 * Run Pyne/Pine scripts through the runner bridge.
 *
 * Owns the `pyneide.runScript` command, the Run CodeLens / editor-title
 * button (via the `pyneide.isPyneScript` context key), the minimal data
 * picker, and the run lifecycle (progress UI, cancellation, logs). The chart
 * webview subscribes to the same event stream (F3 chart task).
 */
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { CompileService } from '../compile/service';
import type { EnvManager } from '../env/manager';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import { detectPyne, DETECT_HEAD_BYTES } from '../pyneDetect';
import { BridgeRun, type BridgeEvent, type TradeRecord } from './bridgeClient';
import { pickRunData } from './dataSelect';

export interface RunListener {
  onEvent(event: BridgeEvent): void;
  onFinished(): void;
}

export class RunService {
  private readonly output = vscode.window.createOutputChannel('PyneIDE Run');
  private activeRun: BridgeRun | undefined;
  /** External subscriber (chart webview) for the live event stream. */
  listener: RunListener | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: EnvManager,
    private readonly compile: CompileService
  ) {}

  register(): void {
    const selector = [{ language: 'python' }, { language: 'pine' }];
    this.context.subscriptions.push(
      this.output,
      vscode.commands.registerCommand('pyneide.runScript', (uri?: vscode.Uri) =>
        this.runFromCommand(uri)
      ),
      vscode.languages.registerCodeLensProvider(selector, new RunCodeLensProvider()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContextKey()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) this.updateContextKey();
      })
    );
    this.updateContextKey();
  }

  private updateContextKey(): void {
    const doc = vscode.window.activeTextEditor?.document;
    const isPyne =
      doc?.languageId === 'pine' ||
      (doc?.languageId === 'python' &&
        detectPyne(doc.getText().slice(0, DETECT_HEAD_BYTES)) !== undefined);
    void vscode.commands.executeCommand('setContext', 'pyneide.isPyneScript', isPyne === true);
  }

  private async runFromCommand(uri?: vscode.Uri): Promise<void> {
    let doc: vscode.TextDocument | undefined;
    if (uri) {
      doc = await vscode.workspace.openTextDocument(uri);
    } else {
      doc = vscode.window.activeTextEditor?.document;
    }
    if (!doc) return;
    await this.runDocument(doc);
  }

  async runDocument(doc: vscode.TextDocument): Promise<void> {
    if (this.activeRun) {
      void vscode.window.showWarningMessage(
        'PyneIDE: a run is already in progress. Cancel it first.'
      );
      return;
    }
    if (doc.isDirty) await doc.save();

    // Resolve the runnable .py: a Pine run always compiles in the background
    // (content-hash cache skips the API when nothing changed).
    this.output.appendLine(`Run requested: ${doc.uri.fsPath} (${doc.languageId})`);
    let scriptPath = doc.uri.fsPath;
    if (doc.languageId === 'pine') {
      const compiled = await this.compile.ensureCompiledForRun(doc);
      if (!compiled) {
        this.output.appendLine('Run stopped: compilation did not produce a runnable .py.');
        return;
      }
      scriptPath = compiled;
    } else if (doc.languageId === 'python') {
      if (detectPyne(doc.getText().slice(0, DETECT_HEAD_BYTES)) === undefined) {
        void vscode.window.showWarningMessage(
          'PyneIDE: this is not a Pyne script (the module docstring must start with @pyne).'
        );
        return;
      }
    } else {
      void vscode.window.showWarningMessage('PyneIDE: open a Pyne (.py) or Pine (.pine) script to run.');
      return;
    }

    this.output.appendLine(`Compiled OK, checking Python environment for: ${scriptPath}`);
    const pythonBin = await this.manager.ensureReady(
      'Running Pyne scripts needs the Python environment. Set it up now?'
    );
    if (!pythonBin) {
      this.output.appendLine('Run stopped: no Python environment available.');
      return;
    }

    const workdir = await this.resolveOrInitWorkdir(doc, scriptPath);
    if (!workdir) {
      this.output.appendLine('Run stopped: no Pyne workdir resolved.');
      return;
    }

    this.output.appendLine(`Workdir resolved: ${workdir} — opening data picker.`);
    const data = await pickRunData(this.context, workdir, scriptPath, pythonBin, this.output);
    if (!data) {
      this.output.appendLine('Run stopped: no data selected.');
      return;
    }

    await this.executeRun({ pythonBin, scriptPath, data, workdir });
  }

  /**
   * Resolve the workdir for a run; when the chain finds nothing, offer the
   * one-click project initialization — never silently adopt a folder.
   */
  private async resolveOrInitWorkdir(
    doc: vscode.TextDocument,
    scriptPath: string
  ): Promise<string | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const resolve = (): string | undefined => {
      const res = resolveWorkspaceWorkdir(folder, path.dirname(scriptPath));
      return res?.exists ? res.path : undefined;
    };
    const existing = resolve();
    if (existing) return existing;

    const choice = await vscode.window.showInformationMessage(
      'PyneIDE: no Pyne workdir found for this script. Initialize the project first?',
      'Initialize Project'
    );
    if (choice !== 'Initialize Project') return undefined;
    await vscode.commands.executeCommand('pyneide.createWorkspace');
    return resolve();
  }

  private async executeRun(opts: {
    pythonBin: string;
    scriptPath: string;
    data: string;
    workdir: string;
  }): Promise<void> {
    const scriptName = path.basename(opts.scriptPath);
    this.output.appendLine(`--- Run: ${scriptName} on ${opts.data} (workdir: ${opts.workdir})`);

    let stats: Record<string, number | null> | undefined;
    let errorMessage: string | undefined;
    const trades: TradeRecord[] = [];
    let barCount = 0;
    let endBars = 0;
    let cancelled = false;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Running ${scriptName} on ${opts.data}`,
        cancellable: true,
      },
      async (progress, token) => {
        let lastDone = 0;
        const run = BridgeRun.start({
          pythonBin: opts.pythonBin,
          bridgeRoot: vscode.Uri.joinPath(this.context.extensionUri, 'python').fsPath,
          script: opts.scriptPath,
          data: opts.data,
          workdir: opts.workdir,
          onEvent: (event) => {
            switch (event.e) {
              case 'bars':
                barCount += event.d.length;
                break;
              case 'trades':
                trades.push(...event.d);
                break;
              case 'progress':
                progress.report({
                  message: `${event.done} bars`,
                  increment: ((event.done - lastDone) / Math.max(event.total, 1)) * 100,
                });
                lastDone = event.done;
                break;
              case 'stats':
                stats = event.d;
                break;
              case 'error':
                errorMessage = event.message;
                this.output.appendLine(event.traceback);
                break;
              case 'log':
                this.output.appendLine(`[${event.level}] ${event.message}`);
                break;
              case 'end':
                endBars = event.bars;
                cancelled = event.cancelled;
                break;
            }
            this.listener?.onEvent(event);
          },
          onLog: (line) => this.output.appendLine(line),
        });
        this.activeRun = run;
        token.onCancellationRequested(() => run.cancel());

        const code = await run.exited;
        this.activeRun = undefined;
        this.listener?.onFinished();
        if (code !== 0 && !errorMessage) {
          errorMessage = `runner exited with code ${code}`;
        }
      }
    );

    if (errorMessage) {
      const choice = await vscode.window.showErrorMessage(
        `PyneIDE: run failed: ${errorMessage}`,
        'Show Log'
      );
      if (choice === 'Show Log') this.output.show();
      return;
    }

    this.output.appendLine(
      `Run finished: ${endBars} bars` +
        (cancelled ? ' (cancelled)' : '') +
        (trades.length ? `, ${trades.length} closed trades` : '')
    );
    const netProfit = stats?.['Net Profit'];
    const summary =
      `PyneIDE: run finished — ${endBars} bars` +
      (trades.length ? `, ${trades.length} trades` : '') +
      (netProfit !== undefined && netProfit !== null ? `, net profit ${netProfit.toFixed(2)}` : '');
    // Non-intrusive: the chart toolbar now owns CSV access, so a transient
    // status-bar note replaces the old dismissable notification toast.
    vscode.window.setStatusBarMessage(summary, 6000);
  }
}

/** "Run ..." CodeLens on the first line of Pyne/Pine scripts. */
class RunCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    let title: string | undefined;
    if (doc.languageId === 'pine') {
      title = '$(play) Run Pine Script';
    } else if (
      doc.languageId === 'python' &&
      detectPyne(doc.getText().slice(0, DETECT_HEAD_BYTES)) !== undefined
    ) {
      title = '$(play) Run Pyne Script';
    }
    if (!title) return [];
    return [
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title,
        command: 'pyneide.runScript',
        arguments: [doc.uri],
      }),
    ];
  }
}
