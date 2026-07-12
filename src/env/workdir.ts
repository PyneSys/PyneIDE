import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Logger } from './constants';
import { execChecked } from './exec';

/**
 * Mirror of pynecore's AppState._find_workdir: walk upwards from `startDir`
 * (max 10 levels) looking for a directory named `workdir`; when none is
 * found, fall back to `<startDir>/workdir` (which may not exist yet).
 */
export function findWorkdir(startDir: string): { path: string; exists: boolean } {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 10; depth++) {
    const candidate = path.join(current, 'workdir');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return { path: candidate, exists: true };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { path: path.join(path.resolve(startDir), 'workdir'), exists: false };
}

export interface WorkdirResolution {
  path: string;
  exists: boolean;
  source: 'setting' | 'search' | 'fallback';
}

/**
 * Resolution chain: explicit `pyneide.workdir` setting (relative to the
 * workspace folder, "." allowed) > upward search from the script's directory >
 * upward search from the workspace folder > fallback `<wsFolder>/workdir`
 * (which may not exist). Returns undefined when there is nothing to go on.
 */
export function resolveWorkdir(opts: {
  setting?: string;
  wsFolder?: string;
  scriptDir?: string;
}): WorkdirResolution | undefined {
  const setting = opts.setting?.trim();
  if (setting) {
    const base = opts.wsFolder ?? opts.scriptDir ?? '.';
    const resolved = path.resolve(base, setting);
    const exists = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
    return { path: resolved, exists, source: 'setting' };
  }
  for (const start of [opts.scriptDir, opts.wsFolder]) {
    if (!start) continue;
    const found = findWorkdir(start);
    if (found.exists) return { path: found.path, exists: true, source: 'search' };
  }
  if (opts.wsFolder) {
    return { path: path.join(path.resolve(opts.wsFolder), 'workdir'), exists: false, source: 'fallback' };
  }
  return undefined;
}

export interface CreatedWorkspace {
  workdir: string;
  demoScript: string;
  created: boolean;
}

/**
 * Scaffold the workdir with the pynecore CLI itself (single source of truth:
 * its app-callback creates the directory layout, config/providers.toml,
 * config/api.toml and the demo script + data). The workdir directory is
 * pre-created so the CLI's interactive "create it?" confirmation is skipped;
 * `run --help` is the cheapest invocation that triggers the callback without
 * doing anything else. `--recreate-demo` is only passed when the demo script
 * is missing, so existing files are never overwritten.
 */
export async function scaffoldWorkdirWithCli(
  pyneBin: string,
  workdir: string,
  log: Logger
): Promise<CreatedWorkspace> {
  if (!fs.existsSync(pyneBin)) {
    throw new Error(
      `pyne CLI not found at ${pyneBin} — the selected Python environment does not have pynecore installed`
    );
  }
  const created = !fs.existsSync(path.join(workdir, 'scripts'));
  fs.mkdirSync(workdir, { recursive: true });
  const demoScript = path.join(workdir, 'scripts', 'demo.py');
  const args = ['--workdir', workdir];
  if (!fs.existsSync(demoScript)) {
    args.push('--recreate-demo');
  }
  args.push('run', '--help');
  await execChecked(pyneBin, args, log, { timeoutMs: 120000 });
  return { workdir, demoScript, created };
}

/**
 * Write `"pyneide.workdir": "."` into `<projectDir>/.vscode/settings.json`,
 * marking the project folder itself as the workdir. Used when no workspace is
 * open, so the VSCode configuration API is not available. Returns false when
 * an existing settings.json could not be parsed (e.g. JSONC comments) — in
 * that case the file is left untouched.
 */
export function markProjectAsWorkdir(projectDir: string): boolean {
  const vscodeDir = path.join(projectDir, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return false;
    }
  }
  settings['pyneide.workdir'] = '.';
  fs.mkdirSync(vscodeDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

/** Marketplace id of the richer TOML extension we suggest (schema + formatting). */
export const TOML_EXTENSION_ID = 'tamasfe.even-better-toml';

/**
 * Add `tamasfe.even-better-toml` to `<projectDir>/.vscode/extensions.json`
 * recommendations. Soft suggestion only: VSCode prompts the user, it is never
 * force-installed. PyneIDE ships baseline TOML highlighting itself, so this is
 * purely for those who also want schema validation/formatting. Returns false
 * when an existing extensions.json could not be parsed (left untouched then).
 */
export function recommendTomlExtension(projectDir: string): boolean {
  const vscodeDir = path.join(projectDir, '.vscode');
  const extensionsPath = path.join(vscodeDir, 'extensions.json');
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(extensionsPath)) {
    try {
      doc = JSON.parse(fs.readFileSync(extensionsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return false;
    }
  }
  const current = Array.isArray(doc.recommendations) ? (doc.recommendations as unknown[]) : [];
  if (!current.some((id) => id === TOML_EXTENSION_ID)) {
    doc.recommendations = [...current, TOML_EXTENSION_ID];
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(extensionsPath, JSON.stringify(doc, null, 2) + '\n');
  }
  return true;
}
