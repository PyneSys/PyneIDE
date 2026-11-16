/**
 * What a live chart run streams: the provider string, the history window and
 * whether a strategy trades on the history too. Remembered per script (keyed by
 * its source path) in workspaceState, so Run Live starts at once after the
 * first pick.
 */
import type * as vscode from 'vscode';

const LIVE_TARGET_KEY = 'pyneide.liveTarget';

/** The history window a live run starts with, as the bridge's `--live-from`. */
export const DEFAULT_LIVE_FROM = '-500';

export interface LiveTarget {
  /** Provider string, e.g. `ccxt:BYBIT:BTC/USDT:USDT@1`. */
  provider: string;
  /** History start: `-N` bars, days or a date. */
  from: string;
  /** A strategy trades on the history and carries that position into the live phase. */
  historyTrades: boolean;
}

/**
 * The provider string of a symbol pick, in the form the download writes into
 * the data `.toml`: `provider:broker:symbol@timeframe`, without the broker for
 * a single-broker provider.
 */
export function liveProviderString(
  provider: string,
  broker: string | undefined,
  symbol: string,
  timeframe: string
): string {
  return broker ? `${provider}:${broker}:${symbol}@${timeframe}` : `${provider}:${symbol}@${timeframe}`;
}

/** The timeframe of a provider string (after its last `@`), or undefined. */
export function providerTimeframe(provider: string): string | undefined {
  const at = provider.lastIndexOf('@');
  return at >= 0 && at < provider.length - 1 ? provider.slice(at + 1) : undefined;
}

/** The provider string on another timeframe. */
export function withTimeframe(provider: string, timeframe: string): string {
  const at = provider.lastIndexOf('@');
  return `${at >= 0 ? provider.slice(0, at) : provider}@${timeframe}`;
}

/** The tab title of a live chart without a script: the provider string
 * without the provider name (`BYBIT:BTC/USDT:USDT@1 — Live`). */
export function liveChartTitle(provider: string): string {
  const colon = provider.indexOf(':');
  return `${colon >= 0 ? provider.slice(colon + 1) : provider} — Live`;
}

function isLiveTarget(value: unknown): value is LiveTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  return typeof target.provider === 'string' && target.provider !== '' &&
    typeof target.from === 'string' && typeof target.historyTrades === 'boolean';
}

/** The live target remembered for a script, if any. */
export function getLiveTarget(
  context: vscode.ExtensionContext,
  scriptKey: string
): LiveTarget | undefined {
  const target = context.workspaceState.get<Record<string, unknown>>(LIVE_TARGET_KEY, {})[scriptKey];
  return isLiveTarget(target) ? target : undefined;
}

export async function setLiveTarget(
  context: vscode.ExtensionContext,
  scriptKey: string,
  target: LiveTarget
): Promise<void> {
  const map = context.workspaceState.get<Record<string, unknown>>(LIVE_TARGET_KEY, {});
  await context.workspaceState.update(LIVE_TARGET_KEY, { ...map, [scriptKey]: target });
}

/** Forget a script's live target, so the next Run Live asks again. */
export async function forgetLiveTarget(
  context: vscode.ExtensionContext,
  scriptKey: string
): Promise<void> {
  const map = { ...context.workspaceState.get<Record<string, unknown>>(LIVE_TARGET_KEY, {}) };
  if (!(scriptKey in map)) return;
  delete map[scriptKey];
  await context.workspaceState.update(LIVE_TARGET_KEY, map);
}
