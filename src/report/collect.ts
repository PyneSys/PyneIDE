/**
 * Assemble a problem report from the live extension state.
 *
 * Hard rule: this module never reads anything under `<workdir>/config/`.
 * `api.toml` holds the PyneSys API key and `providers.toml` the broker
 * credentials — neither may ever end up in a report.
 *
 * Everything collected here is still a *draft*: it goes through
 * {@link finalizePayload} (scrubbing, consent, truncation) before it can leave
 * the machine.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { loadSourcemapFor, sha256, sourcemapPathFor } from '../compile/sourcemap';
import { currentMarker } from '../env/bootstrap';
import { PYNECORE_MIN_VERSION } from '../env/constants';
import type { EnvManager } from '../env/manager';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import type { PineLsService } from '../pinels/service';
import { detectPineVersion } from '../pineVersion';
import { detectPyne, DETECT_HEAD_BYTES } from '../pyneDetect';
import type { FailureRecord } from './lastFailure';
import { logHub } from './logTee';
import { REPORT_SCHEMA_VERSION, type ReportPayload, type ReportSource } from './payload';
import type { ScrubRoots } from './scrub';

/** Settings whose value is a path, URL or otherwise identifying. */
const SENSITIVE_SETTINGS = [
  'pythonPath',
  'venvPath',
  'workdir',
  'pineLs.path',
  'apiBaseUrl',
  'pineLs.baseUrl',
] as const;

/** Settings that are plain booleans and go in as they are. */
const BOOLEAN_SETTINGS = [
  'useOwnPynecore',
  'strictCompile',
  'debug.justMyCode',
  'pyright.enabled',
  'checker.enabled',
  'pineLs.enabled',
  'pineLs.autoUpdate',
] as const;

export interface CollectDeps {
  context: vscode.ExtensionContext;
  manager: EnvManager;
  pineLs: PineLsService;
}

/** The script a report may offer to include. */
export interface ScriptInfo {
  /** Absolute path — never reported, only used to derive the facts below. */
  path: string;
  basename: string;
  language: 'pine' | 'pyne' | 'python';
  source: string;
  lineCount: number;
  sha256: string;
}

export interface CollectedReport {
  draft: ReportPayload;
  roots: ScrubRoots;
  script?: ScriptInfo;
}

/**
 * Whether a setting has a value at all, without revealing what it is. `set`
 * means the user (or a workspace) overrode the shipped default.
 */
function settingState(config: vscode.WorkspaceConfiguration, key: string): 'default' | 'set' {
  const inspected = config.inspect(key);
  const overridden =
    inspected?.globalValue !== undefined ||
    inspected?.workspaceValue !== undefined ||
    inspected?.workspaceFolderValue !== undefined;
  return overridden ? 'set' : 'default';
}

function collectSettings(scope?: vscode.Uri): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration('pyneide', scope);
  const result: Record<string, unknown> = {};
  for (const key of BOOLEAN_SETTINGS) result[key] = config.get<boolean>(key);
  for (const key of SENSITIVE_SETTINGS) result[key] = settingState(config, key);
  // Only whether a proxy is in play — the URL itself often carries credentials.
  const httpProxy = vscode.workspace.getConfiguration('http').get<string>('proxy')?.trim();
  result.proxy_configured = !!httpProxy || !!process.env.HTTPS_PROXY || !!process.env.HTTP_PROXY;
  return result;
}

function collectEnv(manager: EnvManager): Record<string, unknown> {
  const state = manager.state;
  const result: Record<string, unknown> = { kind: state.kind };
  if (state.kind === 'needs-setup') {
    result.cause = state.cause;
    result.reason = state.reason;
  }
  if (state.kind === 'working') result.step = state.step;
  if (state.kind === 'error') result.message = state.message;
  if (state.kind === 'ready') {
    result.source = state.source;
    result.verify = {
      ok: state.verify.ok,
      pythonVersion: state.verify.pythonVersion,
      pynecoreVersion: state.verify.pynecoreVersion,
      debugpyVersion: state.verify.debugpyVersion,
      error: state.verify.error,
    };
  }
  return result;
}

function collectPineLs(pineLs: PineLsService): Record<string, unknown> {
  const state = pineLs.state;
  const result: Record<string, unknown> = { kind: state.kind, serverRunning: pineLs.serverRunning };
  if (state.kind === 'ready') {
    // A custom binary's version string may be anything, including a path-like
    // build tag — the executable path itself is never reported.
    result.version = state.source === 'custom' ? 'custom' : state.version;
    result.source = state.source;
  }
  if (state.kind === 'unsupported') result.target = state.target;
  if (state.kind === 'error') result.message = state.message;
  return result;
}

const isScriptPath = (filePath: string): boolean => /\.(?:pine|py)$/i.test(filePath);

/**
 * Exactly what the user is looking at — never a substitution. Reporting a
 * different file than the open one (say the compiled `.py` for a `.pine`, or
 * the other way round) would silently send something else than what the
 * consent dialog names.
 *
 * The status-bar flow can run with the focus in a panel, where there is no
 * active editor at all; a visible script editor stands in then.
 */
function openScriptPath(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (active && isScriptPath(active)) return active;
  return vscode.window.visibleTextEditors
    .map((editor) => editor.document.uri.fsPath)
    .find(isScriptPath);
}

/**
 * `pine` for Pine Script, `pyne` for a `.py` carrying the `@pyne` marker
 * (including its `edge` and `lib` variants), `python` for any other `.py`.
 * Plain Python matters: a failure in one is usually a different kind of bug
 * than a failure in a Pyne script.
 */
function scriptLanguage(scriptPath: string, source: string): 'pine' | 'pyne' | 'python' {
  if (/\.pine$/i.test(scriptPath)) return 'pine';
  return detectPyne(source.slice(0, DETECT_HEAD_BYTES)) ? 'pyne' : 'python';
}

/** Read the script the report is about, from the failure or the open editor. */
function resolveScript(failure: FailureRecord | undefined): ScriptInfo | undefined {
  const scriptPath = failure?.scriptPath ?? openScriptPath();
  if (!scriptPath) return undefined;

  let source: string;
  try {
    source = fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return undefined;
  }
  return {
    path: scriptPath,
    basename: path.basename(scriptPath),
    language: scriptLanguage(scriptPath, source),
    source,
    lineCount: source.split('\n').length,
    sha256: sha256(source),
  };
}

/** Script facts that are safe without the source itself. */
function scriptContext(script: ScriptInfo): Record<string, unknown> {
  const result: Record<string, unknown> = {
    language: script.language,
    lines: script.lineCount,
  };
  if (script.language === 'pine') result.pine_version = detectPineVersion(script.source) ?? null;
  // Only the pair's existence and freshness is reported — the companion file
  // itself is never sent, the user consented to the open one.
  const pyPath =
    script.language === 'pine' ? script.path.replace(/\.pine$/i, '.py') : script.path;
  const hasPy = fs.existsSync(pyPath);
  if (script.language === 'pine') result.compiled_py_exists = hasPy;
  if (hasPy && fs.existsSync(sourcemapPathFor(pyPath))) {
    result.sourcemap_stale = loadSourcemapFor(pyPath) === undefined;
  }
  return result;
}

/**
 * Collect everything a report is made of. The returned draft still contains
 * the script source and unscrubbed text — only {@link finalizePayload} decides
 * what is actually sent.
 */
export function collectReport(
  deps: CollectDeps,
  source: ReportSource,
  failure: FailureRecord | undefined,
  clientVersion: string
): CollectedReport {
  const { context, manager, pineLs } = deps;
  const workdir = resolveWorkspaceWorkdir();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const script = resolveScript(failure);
  const marker = currentMarker();

  // All five roots matter: env/exec.ts logs the whole spawn command line, which
  // contains the globalStorage python binary and the --workdir/--script/--data
  // arguments.
  const roots: ScrubRoots = {
    workdir: workdir?.path,
    workspace: workspaceFolder,
    storage: context.globalStorageUri.fsPath,
    extension: context.extensionUri.fsPath,
    home: os.homedir(),
  };

  const includeLogs = vscode.workspace
    .getConfiguration('pyneide')
    .get<boolean>('reportProblem.includeLogs', true);

  const reportContext: Record<string, unknown> = {
    platform: process.platform,
    arch: process.arch,
    node_version: process.versions.node,
    vscode_version: vscode.version,
    app_name: vscode.env.appName,
    app_host: vscode.env.appHost,
    language: vscode.env.language,
    // No vscode.env.machineId: a stable device identifier would make this
    // telemetry.
    pinned: {
      schema: marker.schema,
      python: marker.python,
      pynecore: marker.pynecore,
      debugpy: marker.debugpy,
      pynecore_min: PYNECORE_MIN_VERSION,
    },
    pynecore_version:
      manager.state.kind === 'ready' ? manager.state.verify.pynecoreVersion : undefined,
    env: collectEnv(manager),
    pine_ls: collectPineLs(pineLs),
    workdir: { exists: workdir?.exists ?? false, source: workdir?.source },
    settings: collectSettings(workspaceFolder ? vscode.Uri.file(workspaceFolder) : undefined),
  };

  if (failure) {
    reportContext.failure = {
      kind: failure.kind,
      at: new Date(failure.at).toISOString(),
      ...failure.detail,
    };
    if (failure.traceback) reportContext.traceback = failure.traceback;
  }
  if (script) reportContext.script = scriptContext(script);
  if (includeLogs) reportContext.logs_included = true;

  const summary =
    failure?.summary ??
    (source === 'manual' ? 'Manual problem report (no recent failure)' : 'Problem report');

  const draft: ReportPayload = {
    schema_version: REPORT_SCHEMA_VERSION,
    client: 'pyneide',
    client_version: clientVersion,
    source,
    summary,
    include_script: false,
    script: script?.source ?? null,
    script_language: script?.language ?? null,
    script_sha256: script?.sha256 ?? null,
    logs: includeLogs ? formatLogs() : null,
    context: reportContext,
  };

  return { draft, roots, script };
}

/** The retained tail of every wrapped output channel, as one annotated text. */
function formatLogs(): string | null {
  const tails = logHub.tail();
  const parts = Object.entries(tails).map(([name, text]) => `=== ${name} ===\n${text}`);
  return parts.length ? parts.join('\n\n') : null;
}
