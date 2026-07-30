/**
 * Plain-language explanations for the network failures every outbound path can
 * hit — environment setup, the PyneSys API (compile, sign-in, usage, problem
 * report), the Pine LS install, the plugin catalogue and data downloads.
 *
 * Each of those talks to a different origin and any one of them can be blocked
 * on its own, so a failure has to say WHICH one and WHAT to do. The raw text the
 * user used to get tells them neither: `getaddrinfo ENOTFOUND github.com` from
 * Node, a bare `fetch failed` from undici (which keeps the real reason in
 * `cause`), or `Command failed (exit 2)` followed by uv's `Caused by:` chain.
 * The raw text still goes to the log; this only produces the headline.
 *
 * Non-network failures (checksum mismatch, unsupported platform, a resolver
 * conflict) return undefined so their own message is shown unchanged.
 *
 * Kept vscode-free: `src/env` runs headless in the smoke test, and the
 * presentation layer lives in `./notify`.
 */

import { isCancelledError } from '../env/cancel';

export interface FriendlyError {
  /** One-sentence cause, suitable as a notification headline. */
  summary: string;
  /** What to check or change. */
  hint: string;
}

/** Who is calling out, and what that call needs to reach. */
export interface NetworkTarget {
  /** Subject of the hint sentence: "Setup", "Pine compilation", "Sign-in". */
  subject: string;
  /** Everything that must be reachable, named in the hint. */
  reachable: string;
  /** Host to name when the error itself names none (undici often does not). */
  host?: string;
}

/** The hostname of a base URL, for naming the target of a failed request. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Setup pulls from two independent origins; either can be blocked alone. */
export const SETUP_TARGET: NetworkTarget = {
  subject: 'Setup',
  reachable: 'github.com (uv + Python) and pypi.org / files.pythonhosted.org (packages)',
};

/** Any call to the PyneSys API (compile, sign-in, usage, problem report). */
export function apiTarget(subject: string, baseUrl: string): NetworkTarget {
  const host = hostOf(baseUrl);
  return {
    subject,
    reachable: host ? `${host} (the PyneSys API)` : 'the PyneSys API',
    host,
  };
}

/** The signed Pine language server releases. */
export function pineLsTarget(baseUrl: string): NetworkTarget {
  const host = hostOf(baseUrl);
  return {
    subject: 'Installing the Pine language server',
    reachable: host ? `${host} (signed Pine LS releases)` : 'the Pine LS release server',
    host,
  };
}

/** Installing a PyneCore plugin, which resolves and downloads from PyPI. */
export function pypiTarget(subject: string): NetworkTarget {
  return { subject, reachable: 'pypi.org / files.pythonhosted.org' };
}

/** A market-data provider's own servers, reached from the Python side. */
export function providerTarget(subject: string, provider?: string): NetworkTarget {
  return {
    subject,
    reachable: provider ? `the ${provider} servers` : "the data provider's servers",
  };
}

/**
 * Flatten an error and everything it wraps into one searchable string.
 *
 * Both wrapping styles matter: undici reports `fetch failed` and puts the real
 * reason in `cause` (sometimes an AggregateError holding one error per resolved
 * address), and uv's stderr carries its chain in the message text itself.
 */
function errorParts(err: unknown): string[] {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const walk = (current: unknown, depth: number): void => {
    if (depth > 5 || !(current instanceof Error) || seen.has(current)) return;
    seen.add(current);
    parts.push(current.message);
    const code = (current as NodeJS.ErrnoException).code;
    if (code) parts.push(code);
    const aggregated = (current as { errors?: unknown }).errors;
    if (Array.isArray(aggregated)) {
      for (const nested of aggregated) walk(nested, depth + 1);
    }
    walk((current as { cause?: unknown }).cause, depth + 1);
  };
  walk(err, 0);
  if (parts.length === 0) parts.push(String(err));
  return parts;
}

/** Everything an error says, for matching. */
function errorText(err: unknown): string {
  return errorParts(err).join('\n');
}

/**
 * A single-line message that still carries the real cause — `fetch failed`
 * alone says nothing, `fetch failed: getaddrinfo ENOTFOUND api.pynesys.io`
 * does. Error codes are dropped here: they repeat what the message says.
 */
export function flattenErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5 && !seen.has(current); depth++) {
    seen.add(current);
    const message = current.message.trim();
    if (message && !messages.some((m) => m.includes(message))) messages.push(message);
    const aggregated = (current as { errors?: unknown }).errors;
    current =
      (current as { cause?: unknown }).cause ??
      (Array.isArray(aggregated) ? aggregated[0] : undefined);
  }
  return messages.join(': ');
}

/** The host the failure is about: what the error names, else what we called. */
function failingHost(err: unknown, text: string, target: NetworkTarget): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5 && !seen.has(current); depth++) {
    seen.add(current);
    const hostname = (current as { hostname?: unknown }).hostname;
    if (typeof hostname === 'string' && hostname) return hostname;
    const aggregated = (current as { errors?: unknown }).errors;
    current =
      (current as { cause?: unknown }).cause ??
      (Array.isArray(aggregated) ? aggregated[0] : undefined);
  }
  return (
    /enotfound ([a-z0-9.-]+)/i.exec(text)?.[1] ??
    // Python's urllib3/requests name the host in prose instead: a connection
    // pool repr (host='api.bybit.com') or a resolver error.
    /host='([a-z0-9.-]+)'/i.exec(text)?.[1] ??
    /(?:resolve|lookup) '?([a-z0-9-]+(?:\.[a-z0-9-]+)+)'?/i.exec(text)?.[1] ??
    /https?:\/\/([a-z0-9.-]+)/i.exec(text)?.[1] ??
    target.host
  );
}

/**
 * Classify a network failure. The order matters: uv's error chains often carry
 * several of these words at once (a TLS failure still says "error sending
 * request"), so the most specific cause is matched first.
 */
export function describeNetworkError(
  err: unknown,
  target: NetworkTarget
): FriendlyError | undefined {
  if (isCancelledError(err)) return undefined;
  const text = errorText(err);
  const lower = text.toLowerCase();
  // Plain text, no markdown: notifications and the status-bar tooltip both
  // render the summary verbatim.
  const host = failingHost(err, text, target) ?? 'the server';
  const proxyHint =
    `${target.subject} needs ${target.reachable}. ` +
    'Behind a proxy, set "http.proxy" in VS Code settings.';

  if (
    /unable_to_verify|self[_ -]signed|cert_has_expired|depth_zero|unable to get local issuer|unable to verify the first certificate|invalid peer certificate|unknownissuer|certificate verify failed/.test(
      lower
    )
  ) {
    return {
      summary: `the HTTPS certificate of ${host} could not be verified`,
      hint:
        'A corporate proxy or antivirus is likely inspecting the traffic. Set "http.proxy" ' +
        'in VS Code settings, and point NODE_EXTRA_CA_CERTS at your CA bundle.',
    };
  }
  // The DNS/timeout/reset wordings below also cover what the Python side
  // reports through the bridge (urllib3/requests/ccxt), not just Node and uv.
  if (
    /enotfound|eai_again|getaddrinfo|dns error|failed to lookup address|are you offline|failed to resolve|name or service not known|nodename nor servname|temporary failure in name resolution|nameresolutionerror/.test(
      lower
    )
  ) {
    return {
      summary: `${host} could not be resolved — you appear to be offline, or DNS is blocked`,
      hint: proxyHint,
    };
  }
  if (/econnrefused|connection refused/.test(lower)) {
    return {
      summary: `${host} refused the connection`,
      hint: `A firewall or proxy is likely blocking it. ${proxyHint}`,
    };
  }
  if (/etimedout|timed out|timeout|operation timed out/.test(lower)) {
    return {
      summary: `the connection to ${host} timed out`,
      hint: `The link may be very slow, or the host blocked. ${proxyHint}`,
    };
  }
  if (/econnreset|epipe|socket hang up|connection reset|connection closed|incomplete message/.test(lower)) {
    return {
      summary: `the connection to ${host} dropped mid-transfer`,
      hint: `Retry — an interrupted transfer is repeated from scratch, not left corrupt. ${proxyHint}`,
    };
  }
  const status = /http (\d{3})/i.exec(text)?.[1];
  if (status) {
    return {
      summary: `${host} answered with HTTP ${status}`,
      hint:
        status === '403' || status === '429'
          ? 'The host is rate-limiting or blocking this network. Try again later, or from another network.'
          : proxyHint,
    };
  }
  if (
    /fetch failed|failed to fetch|failed to download|error sending request|could not connect|network|enetunreach|ehostunreach|und_err|max retries exceeded|connection aborted/.test(
      lower
    )
  ) {
    return {
      summary: `${host} could not be reached`,
      hint: proxyHint,
    };
  }
  return undefined;
}

/** Whether a failure is the network's fault rather than the user's or ours. */
export function isNetworkError(err: unknown, target: NetworkTarget): boolean {
  return describeNetworkError(err, target) !== undefined;
}

/**
 * One line for surfaces that render a message themselves (webview panes, log):
 * the plain-language explanation when it is a network failure, the flattened
 * raw message otherwise. See `./notify` for the notification form.
 */
export function explainError(err: unknown, target: NetworkTarget): string {
  const friendly = describeNetworkError(err, target);
  return friendly ? `${friendly.summary}. ${friendly.hint}` : flattenErrorMessage(err);
}
