/**
 * Plain-language explanations for the network failures a managed-environment
 * setup can hit.
 *
 * Setup pulls from two independent origins and either can be blocked on its
 * own, so a failure has to say WHICH one and WHAT to do — the raw text the user
 * used to get (`getaddrinfo ENOTFOUND github.com`, `Command failed (exit 2)`
 * followed by uv's `Caused by:` chain) tells them neither. The raw text still
 * goes to the log; this only produces the headline.
 *
 * Non-network failures (checksum mismatch, unsupported platform, a resolver
 * conflict) return undefined so their own message is shown unchanged.
 *
 * Kept vscode-free like the rest of src/env.
 */

import { isCancelledError } from './cancel';

export interface FriendlyError {
  /** One-sentence cause, suitable as a notification headline. */
  summary: string;
  /** What to check or change. */
  hint: string;
}

/** What a setup must be able to reach, in the order it is contacted. */
const SETUP_HOSTS = 'github.com (uv + Python) and pypi.org / files.pythonhosted.org (packages)';

const PROXY_HINT =
  `Setup needs ${SETUP_HOSTS}. Behind a proxy, set "http.proxy" in VS Code settings.`;

/** Flatten an error and its `cause` chain into one searchable string. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    parts.push(current.message);
    const code = (current as NodeJS.ErrnoException).code;
    if (code) parts.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  if (parts.length === 0) parts.push(String(err));
  return parts.join('\n');
}

/** The host the failure is about, when the message or the error names one. */
function failingHost(err: unknown, text: string): string | undefined {
  const hostname = (err as { hostname?: unknown })?.hostname;
  if (typeof hostname === 'string' && hostname) return hostname;
  return (
    /enotfound ([a-z0-9.-]+)/i.exec(text)?.[1] ??
    /https?:\/\/([a-z0-9.-]+)/i.exec(text)?.[1]
  );
}

/**
 * Classify a setup failure. The order matters: uv's error chains often carry
 * several of these words at once (a TLS failure still says "error sending
 * request"), so the most specific cause is matched first.
 */
export function describeSetupError(err: unknown): FriendlyError | undefined {
  if (isCancelledError(err)) return undefined;
  const text = errorText(err);
  const lower = text.toLowerCase();
  // Plain text, no markdown: notifications and the status-bar tooltip both
  // render the summary verbatim.
  const target = failingHost(err, text) ?? 'the download servers';

  if (
    /unable_to_verify|self[_ -]signed|cert_has_expired|depth_zero|unable to get local issuer|invalid peer certificate|unknownissuer|certificate verify failed/.test(
      lower
    )
  ) {
    return {
      summary: `the HTTPS certificate of ${target} could not be verified`,
      hint:
        'A corporate proxy or antivirus is likely inspecting the traffic. Set "http.proxy" ' +
        'in VS Code settings, and point NODE_EXTRA_CA_CERTS at your CA bundle.',
    };
  }
  if (/enotfound|eai_again|getaddrinfo|dns error|failed to lookup address|are you offline/.test(lower)) {
    return {
      summary: `${target} could not be resolved — you appear to be offline, or DNS is blocked`,
      hint: PROXY_HINT,
    };
  }
  if (/econnrefused|connection refused/.test(lower)) {
    return {
      summary: `${target} refused the connection`,
      hint: `A firewall or proxy is likely blocking it. ${PROXY_HINT}`,
    };
  }
  if (/etimedout|timed out|timeout|operation timed out/.test(lower)) {
    return {
      summary: `the connection to ${target} timed out`,
      hint: `The link may be very slow, or the host blocked. ${PROXY_HINT}`,
    };
  }
  if (/econnreset|epipe|socket hang up|connection reset|connection closed|incomplete message/.test(lower)) {
    return {
      summary: `the connection to ${target} dropped mid-transfer`,
      hint: `Retry — an interrupted download is resumed from scratch, not left corrupt. ${PROXY_HINT}`,
    };
  }
  const status = /http (\d{3})/i.exec(text)?.[1];
  if (status) {
    return {
      summary: `${target} answered with HTTP ${status}`,
      hint:
        status === '403' || status === '429'
          ? 'The host is rate-limiting or blocking this network. Try again later, or from another network.'
          : PROXY_HINT,
    };
  }
  if (/failed to fetch|failed to download|error sending request|could not connect|network/.test(lower)) {
    return {
      summary: `${target} could not be reached`,
      hint: PROXY_HINT,
    };
  }
  return undefined;
}
