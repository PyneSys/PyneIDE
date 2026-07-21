/**
 * The Pyne script input editor: a webview form for a script's `input.*()`
 * declarations. Metadata (type, title, defval, options, min/max/step, group,
 * tooltip) comes from the bridge's one-shot `--inspect-inputs` mode; current
 * values come from the sibling `<script>.toml` `[inputs.*]` sections and are
 * written back there on save, preserving the rest of the file.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { EnvManager } from '../env/manager';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import type { InputSpec, InputsOutMessage, InputsPayload, InputValue } from './inputsMessages';
import { readInputValues, writeInputValues } from './inputsToml';

const VIEW_TYPE = 'pyneide.inputsForm';

interface InspectResult {
  inputs: InputSpec[];
  scriptType?: string;
  warning?: string | null;
}

export class InputsViewManager {
  /** Live panels keyed by the script's fsPath (one editor per script). */
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: EnvManager,
    private readonly output: vscode.OutputChannel
  ) {}

  /** Open (or reveal) the input form for a `.py` Pyne script. */
  async open(scriptUri: vscode.Uri): Promise<void> {
    const scriptPath = scriptUri.fsPath;
    const existing = this.panels.get(scriptPath);
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

    const values = this.currentValues(scriptPath, inspect.inputs);

    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Inputs: ${path.basename(scriptPath)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [distRoot] }
    );
    this.panels.set(scriptPath, panel);
    panel.onDidDispose(() => {
      if (this.panels.get(scriptPath) === panel) this.panels.delete(scriptPath);
    });
    panel.webview.html = this.html(panel.webview, distRoot);

    const payload: InputsPayload = {
      script: path.basename(scriptPath),
      scriptType: inspect.scriptType,
      inputs: inspect.inputs,
      values,
      warning: inspect.warning,
    };

    panel.webview.onDidReceiveMessage((msg: InputsOutMessage) => {
      if (msg.type === 'ready') {
        void panel.webview.postMessage({ type: 'data', payload });
      } else if (msg.type === 'save') {
        try {
          this.saveValues(scriptPath, msg.values, inspect.inputs);
          void panel.webview.postMessage({ type: 'saved' });
          void vscode.window.showInformationMessage(
            `PyneIDE: saved inputs for ${path.basename(scriptPath)}.`
          );
        } catch (err) {
          void panel.webview.postMessage({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
  }

  /** Read current input values from the sibling `.toml`, defaulting to defval. */
  private currentValues(scriptPath: string, specs: InputSpec[]): Record<string, InputValue> {
    const tomlPath = scriptPath.replace(/\.py$/i, '.toml');
    let saved: Record<string, InputValue> = {};
    try {
      saved = readInputValues(fs.readFileSync(tomlPath, 'utf8'));
    } catch {
      // No sibling toml yet — fall back to declared defaults below.
    }
    const values: Record<string, InputValue> = {};
    for (const spec of specs) {
      if (spec.name in saved) {
        values[spec.name] = saved[spec.name];
      } else if (spec.defval !== null) {
        values[spec.name] = spec.defval;
      }
    }
    return values;
  }

  private saveValues(
    scriptPath: string,
    values: Record<string, InputValue>,
    specs: InputSpec[]
  ): void {
    const tomlPath = scriptPath.replace(/\.py$/i, '.toml');
    let text = '';
    try {
      text = fs.readFileSync(tomlPath, 'utf8');
    } catch {
      // Missing toml — writeInputValues seeds a minimal [script] header.
    }
    fs.writeFileSync(tomlPath, writeInputValues(text, values, specs), 'utf8');
  }

  /** Spawn the bridge in `--inspect-inputs` mode and parse the `inputs` event. */
  private inspect(
    pythonBin: string,
    bridgeRoot: string,
    workdir: string,
    scriptPath: string
  ): Promise<InspectResult> {
    return new Promise((resolve, reject) => {
      const pythonPath = process.env.PYTHONPATH
        ? `${bridgeRoot}${path.delimiter}${process.env.PYTHONPATH}`
        : bridgeRoot;
      const child = spawn(
        pythonBin,
        ['-X', 'utf8', '-m', 'pyneide_bridge', '--workdir', workdir, '--inspect-inputs', scriptPath],
        {
          cwd: workdir,
          env: { ...process.env, PYTHONPATH: pythonPath, PYNE_WORK_DIR: workdir, PYTHONUNBUFFERED: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      let settled = false;
      let stdoutBuf = '';
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
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
          if (event.e === 'inputs') {
            finish(() =>
              resolve({
                inputs: (event.inputs as InputSpec[]) ?? [],
                scriptType: event.scriptType as string | undefined,
                warning: (event.warning as string | null) ?? null,
              })
            );
          } else if (event.e === 'error') {
            finish(() => reject(new Error(String(event.message ?? 'inspect failed'))));
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.trim()) this.output.appendLine(`[inspect-inputs] ${line}`);
        }
      });

      child.on('error', (err) => finish(() => reject(err)));
      child.on('close', () => finish(() => reject(new Error('inspect-inputs produced no result'))));
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
  .field > label { flex: 0 0 46%; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
