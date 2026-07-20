import * as crypto from 'node:crypto';
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
  ensurePyrightConfig(workdir);
  return { workdir, demoScript, created };
}

/**
 * Fallback `pythonVersion` for a config written before any interpreter is
 * known. Matches pynecore's own `requires-python`, so its stubs always parse;
 * the real interpreter's version replaces it once the environment is ready.
 */
const PYTHON_VERSION_FLOOR = '3.11';

/** `3.14.0` -> `3.14`; undefined for anything that is not a dotted version. */
export function majorMinor(version: string | undefined): string | undefined {
  const match = /^(\d+)\.(\d+)/.exec(version?.trim() ?? '');
  return match ? `${match[1]}.${match[2]}` : undefined;
}

/**
 * Split an interpreter path into pyright's `venvPath` + `venv` pair, or
 * undefined when it is not a virtual environment.
 *
 * The two together are what let a checker resolve imports out of PyneIDE's
 * environment without the editor having that interpreter selected. A bare
 * system interpreter (`/usr/bin/python3`) has no venv to name, and guessing
 * one from its path would point pyright at `/usr` — hence the `pyvenv.cfg`
 * check, which is the definitive marker.
 */
export function venvLocation(
  pythonBin: string | undefined
): { venvPath: string; venv: string } | undefined {
  if (!pythonBin) return undefined;
  // <venv>/bin/python, or <venv>/Scripts/python.exe on Windows.
  const venvDir = path.dirname(path.dirname(pythonBin));
  if (!fs.existsSync(path.join(venvDir, 'pyvenv.cfg'))) return undefined;
  const venv = path.basename(venvDir);
  if (!venv) return undefined;
  return { venvPath: path.dirname(venvDir), venv };
}

/**
 * The generated pyright/Pylance config for Pyne projects. The pieces are the
 * outcome of the L5 typing spike (work/SPIKE-L5.md in this repo):
 * - `defineConstant TYPECHECKER` selects the pyright branch of pynecore's
 *   `types/type_checker.pyi`; without it the PyCharm branch leaks in and
 *   produces ~140 false "not assignable to type_checker.float" errors.
 * - `reportIndexIssue: none` hides the false positives from history-indexing
 *   scalars (`close[1]`) under the transparent `Series[T] = T` alias — the
 *   only noise category the stubs cannot fix. This is the checker-agnostic
 *   fallback; when PyneIDE's own bundled pyright is the analyzer it turns the
 *   rule back on (see `preciseIndexFilter`) and filters per access instead.
 * - `reportRedeclaration: none` follows the same scheme: pynecore's own
 *   `@overload` (`pynecore.core.overload`) redefines one name per
 *   implementation by design, which only the bundled pyright can filter per
 *   def (the analyzer reports the decorated names). Other checkers get the
 *   blanket suppression.
 * - `basic` mode: Pylance's default is "off"; the cleaned-up pynecore stubs
 *   make basic-level checking actually usable on @pyne scripts.
 * - `pythonVersion` is pinned because a type checker infers it from the
 *   interpreter the EDITOR selected, and PyneIDE's managed venv lives in
 *   globalStorage where Pylance never sees it. Left unpinned on a machine
 *   whose default interpreter is old, `typing.TypeAlias` (3.10+) resolves to
 *   Unknown, which collapses pynecore's `Series: TypeAlias = T` into a plain
 *   variable and turns every `Series[...]` annotation into
 *   "Variable not allowed in type expression".
 */
const PYRIGHT_CONFIG = {
  typeCheckingMode: 'basic',
  defineConstant: { TYPECHECKER: 'pyright' },
  reportIndexIssue: 'none',
  reportRedeclaration: 'none',
  pythonVersion: PYTHON_VERSION_FLOOR,
  exclude: ['data', 'output', '**/__pycache__'],
};

/**
 * Whether a parsed config carries our generator's fingerprint. Only configs we
 * wrote get their `extraPaths` reconciled; anything a user authored (or a config
 * shaped differently) is left untouched.
 */
function isGeneratedConfig(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const c = config as Record<string, unknown>;
  const define = c.defineConstant as Record<string, unknown> | undefined;
  return (
    c.typeCheckingMode === 'basic' &&
    (c.reportIndexIssue === 'none' || c.reportIndexIssue === INDEX_RULE_ON) &&
    define?.TYPECHECKER === 'pyright'
  );
}

/**
 * Severity the index rule is restored to for the precise filter. `error`
 * matches what the rule carries in pyright's basic rule set, so a genuine
 * index error looks the same whichever checker surfaced it.
 */
const INDEX_RULE_ON = 'error';

export interface PyrightConfigOptions {
  /**
   * Import roots to place on `extraPaths` so type checkers resolve `pynecore`
   * even from an editable/dev install (whose setuptools import-hook finder is
   * invisible to static analysis). Omit when no interpreter is known yet; an
   * existing generated config keeps whatever extraPaths it already has.
   */
  extraPaths?: string[];
  /**
   * Whether PyneIDE's own pyright is the analyzer here and filters series
   * history indexing per access (L5c) and `@overload` redeclarations per def.
   * True restores `reportIndexIssue`/`reportRedeclaration` so genuine errors
   * reach that filter; false puts the blanket suppression back for whichever
   * checker takes over. Omit to leave the rules as they are.
   *
   * The rule has to live in the file rather than in a client setting:
   * `pyrightconfig.json` outranks `python.analysis.diagnosticSeverityOverrides`,
   * so a config saying `none` cannot be reopened from the LSP side.
   */
  preciseIndexFilter?: boolean;
  /**
   * `major.minor` of the interpreter PyneIDE actually runs scripts with, so
   * checkers analyze against it instead of whatever the editor happens to have
   * selected. Omit while no interpreter is known; the existing value stays.
   */
  pythonVersion?: string;
  /**
   * Interpreter PyneIDE runs scripts with. When it is a virtual environment,
   * its `venvPath`/`venv` go into the config so checkers resolve imports from
   * there — `pythonVersion` fixes the stdlib level, but package resolution
   * still follows the interpreter, and the managed venv is one the editor has
   * never heard of. A non-venv interpreter clears the pair instead.
   */
  pythonBin?: string;
}

/** Write or clear the `venvPath`/`venv` pair; true when the config changed. */
function applyVenv(
  config: Record<string, unknown>,
  venv: { venvPath: string; venv: string } | undefined
): boolean {
  if (!venv) {
    if (config.venvPath === undefined && config.venv === undefined) return false;
    delete config.venvPath;
    delete config.venv;
    return true;
  }
  if (config.venvPath === venv.venvPath && config.venv === venv.venv) return false;
  config.venvPath = venv.venvPath;
  config.venv = venv.venv;
  return true;
}

/**
 * Ensure the generated `pyrightconfig.json` in `dir` is present and current.
 *
 * A missing config is written from the template. An existing config we
 * generated has its `extraPaths` and index-rule severity reconciled to the
 * provided options. A user-authored config — anything without our fingerprint
 * — is never touched. Returns true when the file was written or changed.
 *
 * Note: Pylance only reads the config at the workspace root, so callers pass
 * the workspace folder as well when the workdir is a subfolder.
 */
export function ensurePyrightConfig(dir: string, opts: PyrightConfigOptions = {}): boolean {
  const configPath = path.join(dir, 'pyrightconfig.json');
  const extraPaths = opts.extraPaths?.filter((p) => p.length > 0);
  const indexRule =
    opts.preciseIndexFilter === undefined
      ? undefined
      : opts.preciseIndexFilter
        ? INDEX_RULE_ON
        : 'none';

  const pythonVersion = majorMinor(opts.pythonVersion);
  const venv = venvLocation(opts.pythonBin);

  if (fs.existsSync(configPath)) {
    const wantsExtraPaths = extraPaths !== undefined && extraPaths.length > 0;
    if (
      !wantsExtraPaths &&
      indexRule === undefined &&
      pythonVersion === undefined &&
      opts.pythonBin === undefined
    ) {
      return false;
    }
    let existing: unknown;
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return false;
    }
    if (!isGeneratedConfig(existing)) return false;
    const config = existing as Record<string, unknown>;
    let changed = false;
    if (wantsExtraPaths) {
      const current = Array.isArray(config.extraPaths) ? config.extraPaths : undefined;
      if (!current || JSON.stringify(current) !== JSON.stringify(extraPaths)) {
        config.extraPaths = extraPaths;
        changed = true;
      }
    }
    if (indexRule !== undefined && config.reportIndexIssue !== indexRule) {
      config.reportIndexIssue = indexRule;
      changed = true;
    }
    if (indexRule !== undefined && config.reportRedeclaration !== indexRule) {
      config.reportRedeclaration = indexRule;
      changed = true;
    }
    if (pythonVersion !== undefined && config.pythonVersion !== pythonVersion) {
      config.pythonVersion = pythonVersion;
      changed = true;
    }
    if (opts.pythonBin !== undefined && applyVenv(config, venv)) changed = true;
    if (!changed) return false;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    return true;
  }

  fs.mkdirSync(dir, { recursive: true });
  const config: Record<string, unknown> = { ...PYRIGHT_CONFIG };
  if (extraPaths && extraPaths.length > 0) config.extraPaths = extraPaths;
  if (indexRule !== undefined) {
    config.reportIndexIssue = indexRule;
    config.reportRedeclaration = indexRule;
  }
  if (pythonVersion !== undefined) config.pythonVersion = pythonVersion;
  applyVenv(config, venv);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return true;
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

/**
 * Explorer/search patterns for the generated scaffolding the user should not
 * edit by hand (pyrightconfig.json feeds the type checker, __pycache__ is
 * bytecode noise, .vscode holds machine-written settings, .pyne marks the
 * directory as a PyneCore workdir). Hidden via
 * `files.exclude`, so the files stay in place and keep working — they are just
 * not shown. The settings UI still opens .vscode/settings.json as JSON.
 */
const HIDDEN_FILE_PATTERNS = ['**/__pycache__', '**/pyrightconfig.json', '.vscode', '.pyne'];

/**
 * Merge the scaffolding-hiding patterns into `files.exclude` of
 * `<projectDir>/.vscode/settings.json`. Only missing keys are added — a user
 * who deliberately set a pattern to `false` (unhid it) is respected. Returns
 * false when an existing settings.json could not be parsed (left untouched).
 */
export function hideGeneratedFiles(projectDir: string): boolean {
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
  const current = settings['files.exclude'];
  const exclude: Record<string, unknown> =
    current && typeof current === 'object' ? { ...(current as Record<string, unknown>) } : {};
  let changed = false;
  for (const pattern of HIDDEN_FILE_PATTERNS) {
    if (!(pattern in exclude)) {
      exclude[pattern] = true;
      changed = true;
    }
  }
  if (!changed) return false;
  settings['files.exclude'] = exclude;
  fs.mkdirSync(vscodeDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

/** Generated workspace snippet file, relative to a project's `.vscode`. */
const SNIPPETS_FILE = 'pyne.code-snippets';

/**
 * Marker identifying a snippet file we generated. It carries a hash of the
 * source snippets, so a shipped snippet change regenerates the file without a
 * version constant anyone has to remember to bump.
 */
const SNIPPETS_MARKER = /pyneide-snippets:\s*([0-9a-f]+)/;

/**
 * Install the Pyne snippets as *workspace* snippets in
 * `<projectDir>/.vscode/pyne.code-snippets`.
 *
 * Pyne scripts are plain `.py`, so `contributes.snippets` would scope them to
 * language `python` — i.e. every Python file the user ever opens, Pyne project
 * or not. Their prefixes deliberately mirror the Pine ones (`rsi`, `bb`,
 * `table`, ...), which are ordinary words, so that leak would be noisy.
 * Workspace snippets scope by folder instead, and unlike a
 * `CompletionItemProvider` they stay a first-class snippet source, so the
 * "Insert Snippet" palette keeps listing them.
 *
 * A file without our marker is user-authored and never touched. Returns true
 * when the file was written or refreshed.
 */
export function ensurePyneSnippets(projectDir: string, extensionPath: string): boolean {
  const sourcePath = path.join(extensionPath, 'snippets', 'pyne.json');
  let source: string;
  let snippets: Record<string, Record<string, unknown>>;
  try {
    source = fs.readFileSync(sourcePath, 'utf8');
    snippets = JSON.parse(source) as Record<string, Record<string, unknown>>;
  } catch {
    return false;
  }

  const fingerprint = crypto.createHash('sha256').update(source).digest('hex').slice(0, 12);
  const vscodeDir = path.join(projectDir, '.vscode');
  const targetPath = path.join(vscodeDir, SNIPPETS_FILE);
  if (fs.existsSync(targetPath)) {
    let existing: string;
    try {
      existing = fs.readFileSync(targetPath, 'utf8');
    } catch {
      return false;
    }
    const marker = SNIPPETS_MARKER.exec(existing);
    if (!marker || marker[1] === fingerprint) return false;
  }

  // `scope` is what confines each snippet to Python inside this workspace;
  // without it a .code-snippets entry applies to every language.
  const scoped: Record<string, unknown> = {};
  for (const [name, snippet] of Object.entries(snippets)) {
    scoped[name] = { ...snippet, scope: 'python' };
  }
  const header =
    '// PyneIDE generated — Pyne snippets, scoped to this workspace.\n' +
    '// Delete the marker line below to take ownership; it is then never rewritten.\n' +
    `// pyneide-snippets: ${fingerprint}\n`;
  fs.mkdirSync(vscodeDir, { recursive: true });
  fs.writeFileSync(targetPath, header + JSON.stringify(scoped, null, 2) + '\n');
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
