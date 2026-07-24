/**
 * Data selection for runs: quickpick over the workdir's .ohlcv files plus a
 * "Download new data…" flow that shells out to `pyne data download` with a
 * provider string (same syntax as `pyne run`, e.g. ccxt:BYBIT:BTC/USDT:USDT@1D).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { parseSymInfo } from '../data/syminfo';
import { execChecked } from '../env/exec';
import { pyneBinPath } from '../env/uv';

const LAST_DATA_KEY = 'pyneide.lastRunData';
const LAST_PROVIDER_KEY = 'pyneide.lastProvider';
const LAST_SYMBOL_KEY = 'pyneide.lastSymbol';
const LAST_TIMEFRAME_KEY = 'pyneide.lastTimeframe';

/** Fallback provider names when plugin discovery is unavailable. */
const KNOWN_PROVIDERS = ['ccxt', 'capitalcom', 'tradingview'];

/** TradingView-format timeframes offered by the wizard. */
const TIMEFRAMES = ['1', '5', '15', '60', '240', '1D', '1W'];

interface DataPickItem extends vscode.QuickPickItem {
  action: 'use' | 'download';
  name?: string;
}

function listOhlcv(dataDir: string): { name: string; mtime: number }[] {
  try {
    return fs
      .readdirSync(dataDir)
      .filter((n) => n.endsWith('.ohlcv'))
      .map((n) => ({
        name: n.slice(0, -'.ohlcv'.length),
        mtime: fs.statSync(path.join(dataDir, n)).mtimeMs,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function describeData(dataDir: string, name: string): string | undefined {
  // The sidecar .toml starts with simple key = "value" lines; a cheap regex
  // scrape gives symbol + timeframe without a TOML parser.
  try {
    const head = fs.readFileSync(path.join(dataDir, `${name}.toml`), 'utf8').slice(0, 2048);
    const get = (key: string): string | undefined =>
      new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(head)?.[1];
    const ticker = get('ticker');
    const period = get('period');
    if (ticker && period) return `${ticker} @ ${period}`;
    return ticker ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The data name remembered for a script (keyed by its source path), or
 * undefined when nothing is remembered or the remembered `.ohlcv` is gone.
 * Lets a run reuse the last choice silently instead of prompting every time.
 */
export function getRememberedData(
  context: vscode.ExtensionContext,
  workdir: string,
  scriptKey: string
): string | undefined {
  const name = context.workspaceState.get<Record<string, string>>(LAST_DATA_KEY, {})[scriptKey];
  if (!name) return undefined;
  return fs.existsSync(path.join(workdir, 'data', `${name}.ohlcv`)) ? name : undefined;
}

/**
 * Pick (or download) the OHLCV data for a run. Returns the data name to pass
 * to the bridge (bare stem, resolved against `<workdir>/data`). The choice is
 * remembered per script (keyed by `scriptKey`, the user's source path).
 */
export async function pickRunData(
  context: vscode.ExtensionContext,
  workdir: string,
  scriptKey: string,
  pythonBin: string,
  output: vscode.OutputChannel
): Promise<string | undefined> {
  const dataDir = path.join(workdir, 'data');
  for (;;) {
    const files = listOhlcv(dataDir);
    const lastMap = context.workspaceState.get<Record<string, string>>(LAST_DATA_KEY, {});
    const last = lastMap[scriptKey];
    files.sort((a, b) => (a.name === last ? -1 : b.name === last ? 1 : 0));

    const items: DataPickItem[] = files.map((f) => ({
      action: 'use',
      name: f.name,
      label: `$(graph-line) ${f.name}`,
      description: describeData(dataDir, f.name),
      detail: f.name === last ? 'last used for this script' : undefined,
    }));
    items.push({
      action: 'download',
      label: '$(cloud-download) Download new data…',
      description: 'pyne data download (provider string, e.g. ccxt:BYBIT:BTC/USDT:USDT@1D)',
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: files.length
        ? 'Select OHLCV data to run the script on'
        : 'No OHLCV data in the workdir yet — download some',
      matchOnDescription: true,
    });
    if (!picked) return undefined;

    if (picked.action === 'use' && picked.name) {
      lastMap[scriptKey] = picked.name;
      await context.workspaceState.update(LAST_DATA_KEY, lastMap);
      return picked.name;
    }

    const downloaded = await downloadData(context, workdir, pythonBin, output);
    if (downloaded) {
      lastMap[scriptKey] = downloaded;
      await context.workspaceState.update(LAST_DATA_KEY, lastMap);
      return downloaded;
    }
    // Download cancelled/failed: fall through to the picker again.
    if (downloaded === undefined) return undefined;
  }
}

interface ProviderInfo {
  name: string;
  display_name?: string;
  version?: string;
  summary?: string;
}

/** Installed data providers, from `pyne plugin list --type provider --json`
 * (entry-point discovery). Falls back to the shipped names if the CLI call
 * fails or predates the `--json` flag. */
async function listProviders(
  pyneBin: string,
  workdir: string,
  output: vscode.OutputChannel
): Promise<ProviderInfo[]> {
  try {
    const result = await execChecked(
      pyneBin,
      ['plugin', 'list', '--type', 'provider', '--json'],
      (line) => output.appendLine(line),
      {
        timeoutMs: 60 * 1000,
        env: { ...process.env, PYNE_WORK_DIR: workdir, PYNE_NO_LOGO: '1' },
      }
    );
    const parsed = JSON.parse(result.stdout.trim()) as { plugins?: ProviderInfo[] };
    if (parsed.plugins?.length) return parsed.plugins;
  } catch (err) {
    output.appendLine(`PyneIDE: provider discovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return KNOWN_PROVIDERS.map((name) => ({ name }));
}

/** Walk the provider -> symbol -> timeframe -> range wizard, returning the
 * `pyne data download` arguments (after `data download`), or null on cancel. */
async function runDownloadWizard(
  context: vscode.ExtensionContext,
  workdir: string,
  pyneBin: string,
  output: vscode.OutputChannel
): Promise<string[] | null> {
  const providers = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'PyneIDE: listing data providers…' },
    () => listProviders(pyneBin, workdir, output)
  );
  const lastProvider = context.globalState.get<string>(LAST_PROVIDER_KEY);
  const providerItems: vscode.QuickPickItem[] = providers.map((p) => ({
    label: p.name,
    description: [p.display_name !== p.name ? p.display_name : undefined, p.version ? `v${p.version}` : undefined]
      .filter(Boolean)
      .join(' ')
      .trim(),
    detail: p.name === lastProvider ? `last used${p.summary ? ` — ${p.summary}` : ''}` : p.summary,
  }));
  providerItems.push({ label: '$(edit) Other provider…', description: 'type a provider name' });
  const pickedProvider = await vscode.window.showQuickPick(providerItems, {
    placeHolder: 'Data provider',
  });
  if (!pickedProvider) return null;
  let provider: string;
  if (pickedProvider.label.startsWith('$(edit)')) {
    const typed = await vscode.window.showInputBox({
      title: 'Data provider',
      prompt: 'Provider name (e.g. ccxt)',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Provider name is required'),
    });
    if (!typed) return null;
    provider = typed.trim();
  } else {
    provider = pickedProvider.label;
  }
  await context.globalState.update(LAST_PROVIDER_KEY, provider);

  const symbol = await vscode.window.showInputBox({
    title: `Download from ${provider}`,
    prompt: 'Symbol (e.g. BYBIT:BTC/USDT:USDT)',
    value: context.globalState.get<string>(LAST_SYMBOL_KEY, ''),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Symbol is required'),
  });
  if (!symbol) return null;
  await context.globalState.update(LAST_SYMBOL_KEY, symbol.trim());

  const lastTf = context.globalState.get<string>(LAST_TIMEFRAME_KEY, '1D');
  const timeframe = await vscode.window.showQuickPick(
    TIMEFRAMES.map((tf) => ({ label: tf, description: tf === lastTf ? 'last used' : undefined })),
    { placeHolder: 'Timeframe (TradingView format)' }
  );
  if (!timeframe) return null;
  await context.globalState.update(LAST_TIMEFRAME_KEY, timeframe.label);

  const from = await pickDownloadRange();
  if (from === null) return null;

  return ['data', 'download', provider, '-s', symbol.trim(), '-tf', timeframe.label, '-f', from];
}

/**
 * The "how far back" range picker, shared by the full download wizard and the
 * per-file "download another timeframe" action. Returns the `-f`/`--from`
 * value (`continue`, a day count, or a `YYYY-MM-DD` start date), or null on
 * cancel.
 */
async function pickDownloadRange(): Promise<string | null> {
  const range = await vscode.window.showQuickPick(
    [
      { label: 'Continue / last year', description: 'resume previous download, or 1 year if new', value: 'continue' },
      { label: '30 days', value: '30' },
      { label: '90 days', value: '90' },
      { label: '365 days', value: '365' },
      { label: '$(calendar) Custom date…', description: 'YYYY-MM-DD start date', value: 'custom' },
    ],
    { placeHolder: 'How far back to download?' }
  );
  if (!range) return null;
  if (range.value !== 'custom') return range.value;
  const date = await vscode.window.showInputBox({
    title: 'Download start date',
    prompt: 'Start date (YYYY-MM-DD)',
    ignoreFocusOut: true,
    validateInput: (v) =>
      /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? undefined : 'Expected YYYY-MM-DD',
  });
  if (!date) return null;
  return date.trim();
}

/** Shell out to `pyne <args>` with a progress notification; returns true on
 * success, false on error (an error message with a Show Log action is shown). */
async function runPyne(
  pyneBin: string,
  workdir: string,
  args: string[],
  title: string,
  output: vscode.OutputChannel
): Promise<boolean> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false,
      },
      () =>
        execChecked(pyneBin, ['--workdir', workdir, ...args], (line) => output.appendLine(line), {
          timeoutMs: 15 * 60 * 1000,
          env: { ...process.env, PYNE_WORK_DIR: workdir },
        })
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\[download\]/.test(message)) {
      const choice = await vscode.window.showErrorMessage(
        'PyneIDE: this data file has no saved provider — use "Download Data…" to re-download it once.',
        'Download Data…'
      );
      if (choice === 'Download Data…') void vscode.commands.executeCommand('pyneide.dataDownloadWizard');
      return false;
    }
    const choice = await vscode.window.showErrorMessage(`PyneIDE: ${title} failed: ${message}`, 'Show Log');
    if (choice === 'Show Log') output.show();
    return false;
  }
}

/**
 * Run the download wizard and `pyne data download`; returns the stem of the
 * freshest .ohlcv in the data dir on success, null to return to the picker.
 */
export async function downloadData(
  context: vscode.ExtensionContext,
  workdir: string,
  pythonBin: string,
  output: vscode.OutputChannel
): Promise<string | undefined | null> {
  const pyneBin = pyneBinPath(pythonBin);
  const args = await runDownloadWizard(context, workdir, pyneBin, output);
  if (!args) return null;

  const dataDir = path.join(workdir, 'data');
  const before = new Set(listOhlcv(dataDir).map((f) => f.name));

  const ok = await runPyne(pyneBin, workdir, args, 'Downloading OHLCV data', output);
  if (!ok) return null;

  // Prefer a newly appeared file; fall back to the freshest (a re-download
  // only touches an existing one).
  const after = listOhlcv(dataDir);
  const fresh = after.filter((f) => !before.has(f.name)).sort((a, b) => b.mtime - a.mtime)[0];
  const newest = fresh ?? after.sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) {
    void vscode.window.showWarningMessage('PyneIDE: download finished but no .ohlcv appeared.');
    return null;
  }
  return newest.name;
}

/**
 * Update an existing `.ohlcv` in place: `pyne data download <path> -f continue`,
 * re-using the provider string saved in its sibling `.toml`.
 */
export async function updateData(
  workdir: string,
  pythonBin: string,
  ohlcvPath: string,
  output: vscode.OutputChannel
): Promise<void> {
  const pyneBin = pyneBinPath(pythonBin);
  await runPyne(
    pyneBin,
    workdir,
    ['data', 'download', ohlcvPath, '-f', 'continue'],
    `Updating ${path.basename(ohlcvPath)}`,
    output
  );
}

/**
 * Truncate an `.ohlcv` and re-download it from scratch (modal confirm), using
 * the provider string saved in its sibling `.toml`.
 */
export async function truncateData(
  workdir: string,
  pythonBin: string,
  ohlcvPath: string,
  output: vscode.OutputChannel
): Promise<void> {
  const name = path.basename(ohlcvPath);
  const choice = await vscode.window.showWarningMessage(
    `Truncate and re-download ${name}? All existing data in this file will be lost.`,
    { modal: true },
    'Truncate & Download'
  );
  if (choice !== 'Truncate & Download') return;
  const pyneBin = pyneBinPath(pythonBin);
  await runPyne(
    pyneBin,
    workdir,
    ['data', 'download', ohlcvPath, '--truncate'],
    `Re-downloading ${name}`,
    output
  );
}

/**
 * Download a DIFFERENT timeframe of the same instrument as an existing
 * `.ohlcv`: read the provider string saved in its sibling `.toml`, drop the
 * `@timeframe` suffix, and re-run `pyne data download` with a new `-tf`. The
 * provider, broker and symbol are taken verbatim from the saved string (so the
 * provider constructor names the new file correctly — see the OHLCV naming
 * rule); a provider string without `@timeframe` is the `request.security()`
 * form, so `-tf` is honored rather than ignored.
 */
export async function downloadOtherTimeframe(
  workdir: string,
  pythonBin: string,
  ohlcvPath: string,
  output: vscode.OutputChannel
): Promise<void> {
  const tomlPath = `${ohlcvPath.slice(0, -path.extname(ohlcvPath).length)}.toml`;
  let providerString: string | undefined;
  try {
    providerString = parseSymInfo(fs.readFileSync(tomlPath, 'utf8')).provider;
  } catch {
    providerString = undefined;
  }
  if (!providerString) {
    void vscode.window.showWarningMessage(
      'PyneIDE: this data file has no saved provider — use "Download Data…" to re-download it once.'
    );
    return;
  }
  const at = providerString.lastIndexOf('@');
  const base = at > 0 ? providerString.slice(0, at) : providerString;
  const currentTf = at > 0 ? providerString.slice(at + 1) : undefined;

  const timeframe = await vscode.window.showQuickPick(
    TIMEFRAMES.map((tf) => ({ label: tf, description: tf === currentTf ? 'current' : undefined })),
    { placeHolder: `New timeframe for ${base}` }
  );
  if (!timeframe) return;
  const from = await pickDownloadRange();
  if (from === null) return;

  const pyneBin = pyneBinPath(pythonBin);
  const ok = await runPyne(
    pyneBin,
    workdir,
    ['data', 'download', base, '-tf', timeframe.label, '-f', from],
    `Downloading ${base}@${timeframe.label}`,
    output
  );
  if (ok) void vscode.commands.executeCommand('pyneide.workspace.refresh');
}
