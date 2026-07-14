/**
 * Data selection for runs: quickpick over the workdir's .ohlcv files plus a
 * "Download new data…" flow that shells out to `pyne data download` with a
 * provider string (same syntax as `pyne run`, e.g. ccxt:BYBIT:BTC/USDT:USDT@1D).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { execChecked } from '../env/exec';
import { pyneBinPath } from '../env/uv';

const LAST_DATA_KEY = 'pyneide.lastRunData';
const LAST_PROVIDER_KEY = 'pyneide.lastProviderString';

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

/**
 * Run `pyne data download` with a provider string; returns the stem of the
 * freshest .ohlcv in the data dir on success, null to return to the picker.
 */
async function downloadData(
  context: vscode.ExtensionContext,
  workdir: string,
  pythonBin: string,
  output: vscode.OutputChannel
): Promise<string | undefined | null> {
  const providerString = await vscode.window.showInputBox({
    title: 'Download OHLCV data',
    prompt: 'Provider string: provider:SYMBOL@TIMEFRAME (same syntax as pyne run)',
    value: context.globalState.get<string>(LAST_PROVIDER_KEY, 'ccxt:BYBIT:BTC/USDT:USDT@1D'),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().includes(':') ? undefined : 'Expected provider:SYMBOL[@TIMEFRAME]'),
  });
  if (!providerString) return null;
  await context.globalState.update(LAST_PROVIDER_KEY, providerString.trim());

  const range = await vscode.window.showQuickPick(
    [
      { label: 'Continue / last year', description: 'resume previous download, or 1 year if new', value: 'continue' },
      { label: '30 days', value: '30' },
      { label: '90 days', value: '90' },
      { label: '365 days', value: '365' },
    ],
    { placeHolder: 'How far back to download?' }
  );
  if (!range) return null;

  const pyneBin = pyneBinPath(pythonBin);
  const dataDir = path.join(workdir, 'data');
  const before = new Set(listOhlcv(dataDir).map((f) => f.name));

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Downloading ${providerString.trim()}`,
        cancellable: false,
      },
      () =>
        execChecked(
          pyneBin,
          ['--workdir', workdir, 'data', 'download', providerString.trim(), '-f', range.value],
          (line) => output.appendLine(line),
          { timeoutMs: 15 * 60 * 1000, env: { ...process.env, PYNE_WORK_DIR: workdir } }
        )
    );
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(
      `PyneIDE: data download failed: ${err instanceof Error ? err.message : String(err)}`,
      'Show Log'
    );
    if (choice === 'Show Log') output.show();
    return null;
  }

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
