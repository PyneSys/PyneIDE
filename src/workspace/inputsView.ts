/**
 * The Pyne script input editor: a webview form for a script's `input.*()`
 * declarations. Metadata (type, title, defval, options, min/max/step, group,
 * tooltip) comes from the bridge's one-shot `--inspect-inputs` mode; current
 * values come from the sibling `<script>.toml` `[inputs.*]` sections and are
 * written back there on save, preserving the rest of the file.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { canonicalChartKey, openChartKeys } from '../chart/chartKey';
import type { EnvManager } from '../env/manager';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import type { InputSpec, InputsOutMessage, InputsPayload, InputValue } from './inputsMessages';

const VIEW_TYPE = 'pyneide.inputsForm';

interface InspectResult {
  inputs: InputSpec[];
  /** Current values, read back through pynecore's own toml loader. */
  values: Record<string, InputValue>;
  scriptType?: string;
  warning?: string | null;
}

export class InputsViewManager {
  /**
   * Live panels keyed by the canonical chart key — a `.pine` and its compiled
   * `.py` share one form (both back the same sibling `.toml`), exactly like the
   * chart. One panel per script.
   */
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: EnvManager,
    private readonly output: vscode.OutputChannel,
    private readonly onDidSave?: (chartKey: string) => Promise<void>
  ) {}

  /**
   * Close input forms whose script is no longer open in ANY editor tab (neither
   * the `.pine` nor its `.py`) — the same lifetime rule as the chart. Closing
   * only the form's own tab keeps nothing dormant; it just disposes.
   */
  reconcile(): void {
    const live = openChartKeys();
    for (const [key, panel] of [...this.panels]) {
      if (!live.has(key)) panel.dispose();
    }
  }

  /** Open (or reveal) the input form for a `.py` Pyne script. */
  async open(scriptUri: vscode.Uri): Promise<void> {
    const scriptPath = scriptUri.fsPath;
    const key = canonicalChartKey(scriptPath);
    // A `.pine` and its `.py` are one script, so the label is the shared stem
    // with no extension (like the chart tab).
    const displayName = path.parse(key).name;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }

    const workdir = resolveWorkspaceWorkdir();
    if (!workdir?.exists) {
      void vscode.window.showWarningMessage(
        'PyneIDE: no Pyne workspace found — initialize one first.'
      );
      return;
    }
    const pythonBin = await this.manager.ensureReady(
      'Reading a script\'s inputs uses the pyne bridge, so the Python environment must be set up first.'
    );
    if (!pythonBin) return;

    const bridgeRoot = vscode.Uri.joinPath(this.context.extensionUri, 'python').fsPath;
    let inspect: InspectResult;
    try {
      inspect = await this.inspect(pythonBin, bridgeRoot, workdir.path, scriptPath);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `PyneIDE: could not read inputs — ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    const values = inspect.values;

    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Inputs: ${displayName}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [distRoot] }
    );
    this.panels.set(key, panel);
    panel.onDidDispose(() => {
      if (this.panels.get(key) === panel) this.panels.delete(key);
    });
    panel.webview.html = this.html(panel.webview, distRoot);

    const payload: InputsPayload = {
      script: displayName,
      scriptType: inspect.scriptType,
      inputs: inspect.inputs,
      values,
      warning: inspect.warning,
    };

    panel.webview.onDidReceiveMessage((msg: InputsOutMessage) => {
      if (msg.type === 'ready') {
        void panel.webview.postMessage({ type: 'data', payload });
      } else if (msg.type === 'save') {
        this.writeInputs(pythonBin, bridgeRoot, workdir.path, scriptPath, msg.values)
          .then(() => {
            void panel.webview.postMessage({ type: 'saved' });
            void vscode.window.showInformationMessage(
              `PyneIDE: saved inputs for ${displayName}.`
            );
            void this.onDidSave?.(key).catch((err: unknown) => {
              this.output.appendLine(
                `Input-triggered chart refresh failed: ${err instanceof Error ? err.message : String(err)}`
              );
            });
          })
          .catch((err: unknown) => {
            void panel.webview.postMessage({
              type: 'error',
              message: err instanceof Error ? err.message : String(err),
            });
          });
      }
    });
  }

  /** Spawn the bridge in `--inspect-inputs` mode: the fields AND the current
   * values both come from pynecore (the values via its own toml loader). */
  private async inspect(
    pythonBin: string,
    bridgeRoot: string,
    workdir: string,
    scriptPath: string
  ): Promise<InspectResult> {
    const event = await this.oneShot(
      pythonBin,
      bridgeRoot,
      workdir,
      ['--inspect-inputs', scriptPath],
      'inputs'
    );
    const inputs = (event.inputs as Array<InputSpec & { value?: InputValue | null }>) ?? [];
    const values: Record<string, InputValue> = {};
    for (const it of inputs) {
      if (it.value !== null && it.value !== undefined) values[it.name] = it.value;
    }
    return {
      inputs,
      values,
      scriptType: event.scriptType as string | undefined,
      warning: (event.warning as string | null) ?? null,
    };
  }

  /** Persist input values through the bridge's canonical writer (pynecore's
   * `Script.save`) — the IDE never generates a second toml format. */
  private async writeInputs(
    pythonBin: string,
    bridgeRoot: string,
    workdir: string,
    scriptPath: string,
    values: Record<string, InputValue>
  ): Promise<void> {
    await this.oneShot(
      pythonBin,
      bridgeRoot,
      workdir,
      ['--write-inputs', scriptPath],
      'written',
      { values }
    );
  }

  /**
   * Run a one-shot bridge subcommand and resolve with the first `wantEvent`
   * event (or reject on an `error` event). When `stdinJson` is given it is
   * written to the child's stdin as JSON (used by `--write-inputs`).
   */
  private oneShot(
    pythonBin: string,
    bridgeRoot: string,
    workdir: string,
    extraArgs: string[],
    wantEvent: string,
    stdinJson?: unknown
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const pythonPath = process.env.PYTHONPATH
        ? `${bridgeRoot}${path.delimiter}${process.env.PYTHONPATH}`
        : bridgeRoot;
      const child = spawn(
        pythonBin,
        ['-X', 'utf8', '-m', 'pyneide_bridge', '--workdir', workdir, ...extraArgs],
        {
          cwd: workdir,
          env: { ...process.env, PYTHONPATH: pythonPath, PYNE_WORK_DIR: workdir, PYTHONUNBUFFERED: '1' },
          stdio: [stdinJson !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        }
      );
      if (stdinJson !== undefined && child.stdin) {
        child.stdin.end(JSON.stringify(stdinJson));
      }

      let settled = false;
      let stdoutBuf = '';
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let event: { e?: string; [key: string]: unknown };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.e === wantEvent) {
            finish(() => resolve(event));
          } else if (event.e === 'error') {
            finish(() => reject(new Error(String(event.message ?? `${wantEvent} failed`))));
          }
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.trim()) this.output.appendLine(`[${extraArgs[0]}] ${line}`);
        }
      });

      child.on('error', (err) => finish(() => reject(err)));
      child.on('close', () =>
        finish(() => reject(new Error(`${extraArgs[0]} produced no result`)))
      );
    });
  }

  private html(webview: vscode.Webview, distRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'inputs-form.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src ${webview.cspSource}; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-size: 13px;
  }
  #root { max-width: 720px; margin: 0 auto; padding: 12px 16px 80px; }
  #header { position: sticky; top: 0; z-index: 2;
    background: var(--vscode-editor-background);
    padding: 8px 0 10px; border-bottom: 1px solid var(--vscode-panel-border, #444);
    display: flex; align-items: center; gap: 12px; }
  #title { font-size: 14px; font-weight: 600; flex: 1 1 auto;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #warning { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 8px 0; }
  .group { margin-top: 16px; }
  .group > h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground); margin: 0 0 6px; font-weight: 600; }
  .field { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
  .field > label { flex: 0 0 44%; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .help { flex: 0 0 18px; width: 18px; height: 18px; box-sizing: border-box;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 50%; border: 1px solid var(--vscode-descriptionForeground);
    color: var(--vscode-descriptionForeground);
    font-size: 11px; line-height: 1; font-weight: 600; cursor: pointer;
    user-select: none; opacity: 0.7; }
  .help:hover { opacity: 1; color: var(--vscode-foreground);
    border-color: var(--vscode-foreground); }
  .help.empty { border: none; cursor: default; }
  .tooltip-pop { position: fixed; z-index: 100; max-width: 320px;
    background: var(--vscode-editorHoverWidget-background, #252526);
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
    border-radius: 4px; padding: 8px 10px; font-size: 13px; line-height: 1.45;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
  .field > .control { flex: 1 1 auto; display: flex; align-items: center; gap: 8px; }
  input[type=text], input[type=number], select {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 2px; padding: 3px 6px; font-family: inherit; font-size: 12px;
  }
  input[type=checkbox] { width: 16px; height: 16px; }
  input[type=color] { width: 40px; height: 24px; padding: 0; border: none; background: none; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 2px; padding: 5px 14px; cursor: pointer; font-size: 12px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, #444);
  }
  #empty { color: var(--vscode-descriptionForeground); padding: 24px 0; }
</style>
</head>
<body>
<div id="root">
  <div id="header">
    <div id="title">Loading…</div>
    <button id="reset" class="secondary" type="button" hidden>Reset to defaults</button>
    <button id="save" type="button" hidden>Save</button>
  </div>
  <div id="warning" hidden></div>
  <div id="fields"></div>
  <div id="empty" hidden>This script declares no inputs.</div>
</div>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
