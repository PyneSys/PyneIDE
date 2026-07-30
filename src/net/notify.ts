/**
 * One way to report a failed network call to the user.
 *
 * Every outbound path used to invent its own wording and its own buttons, so an
 * offline user got "compilation failed: fetch failed" with a "Report a Problem"
 * button in one place and a raw `getaddrinfo` string in another. This puts the
 * same sentence and the same first action — Retry — behind all of them.
 */

import * as vscode from 'vscode';

import {
  describeNetworkError,
  flattenErrorMessage,
  type FriendlyError,
  type NetworkTarget,
} from './errors';

export interface NetworkErrorAction {
  title: string;
  run: () => void | Promise<void>;
}

export interface NetworkErrorOptions {
  /** Sentence fragment naming what failed: "compilation failed". */
  headline: string;
  error: unknown;
  target: NetworkTarget;
  /**
   * Retry the very same operation. Offered first, because for a network
   * failure it is what actually helps. Callers that cannot safely re-enter
   * (a queued job retrying itself, a running installer) must schedule the
   * retry instead of awaiting it here.
   */
  retry?: () => void | Promise<void>;
  /** Extra actions, shown after Retry. */
  actions?: NetworkErrorAction[];
  /** Adds a "Show Log" button when given. */
  showLog?: () => void;
}

const RETRY = 'Retry';
const SHOW_LOG = 'Show Log';

/**
 * The message text for a failed call: a plain-language cause and a hint when
 * the failure is the network's, the flattened raw message otherwise (flattened
 * because undici's own message is just "fetch failed").
 */
export function networkErrorMessage(
  headline: string,
  error: unknown,
  target: NetworkTarget
): { text: string; friendly: FriendlyError | undefined } {
  const friendly = describeNetworkError(error, target);
  return {
    friendly,
    text: friendly
      ? `PyneIDE: ${headline} — ${friendly.summary}. ${friendly.hint}`
      : `PyneIDE: ${headline}: ${flattenErrorMessage(error)}`,
  };
}

/**
 * Show a failed network call and run whichever action the user picks. Returns
 * the classification so the caller can branch on it — an offline blip is not
 * something to record as a bug report.
 */
export async function showNetworkError(
  options: NetworkErrorOptions
): Promise<FriendlyError | undefined> {
  const { headline, error, target, retry, actions = [], showLog } = options;
  const { text, friendly } = networkErrorMessage(headline, error, target);

  const items = [
    ...(retry ? [RETRY] : []),
    ...actions.map((a) => a.title),
    ...(showLog ? [SHOW_LOG] : []),
  ];
  const choice = await vscode.window.showErrorMessage(text, ...items);
  if (choice === RETRY) {
    await retry?.();
  } else if (choice === SHOW_LOG) {
    showLog?.();
  } else if (choice !== undefined) {
    await actions.find((a) => a.title === choice)?.run();
  }
  return friendly;
}
