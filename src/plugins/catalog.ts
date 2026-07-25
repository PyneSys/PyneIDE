/**
 * Client for the PyneSys plugin index (`GET /plugins/index.json`,
 * `GET /plugins/{package}`). The index is public — no API key is involved, so
 * the catalogue works signed out.
 *
 * The whole index arrives in one document (the server pages internally), which
 * keeps the client free of paging and lets the panel filter/search locally. The
 * response carries a stable ETag computed from the plugin list only, so a
 * conditional request answers 304 while nothing changed; the caller keeps the
 * last snapshot and can serve it offline.
 *
 * Uses the global fetch for the same reason as src/api/client.ts: the extension
 * host's node:https proxy patch drops chunked Cloudflare bodies.
 */
import { compareVersions } from '../env/bootstrap';

export type PluginTier = 'official' | 'verified' | 'community';
/** `removed` and blocked packages are never served, so only these two show up. */
export type PluginStatus = 'active' | 'yanked';
export type PluginCapability = 'provider' | 'live_provider' | 'broker' | 'cli';

export interface PluginListItem {
  /** Exact PyPI package name — this is what gets installed. */
  package: string;
  version: string;
  summary: string;
  tier: PluginTier;
  status: PluginStatus;
  /** Entry point names, i.e. what the plugin is called on the command line. */
  plugin_ids: string[];
  requires_pynecore: string;
  /** Lowest PyneCore version the specifier allows, pre-parsed by the server. */
  min_pynecore: string;
  capabilities: PluginCapability[];
  downloads_30d?: number | null;
  updated_at?: string | null;
}

export interface PluginEntryPointInfo {
  name: string;
  value: string;
}

export interface PluginExchangeCapabilityInfo {
  name: string;
  level: string;
  varies: boolean;
}

export interface PluginLinkInfo {
  name: string;
  url: string;
}

export interface PluginDetail extends PluginListItem {
  /**
   * The plugin author's own description: the docstring of the entry point's
   * class, read statically out of the wheel — the same text `pyne plugin info`
   * prints. Third-party plain text, so it must be escaped before display.
   * Absent on index entries written before the field existed (they carry it
   * only after a re-check), hence optional.
   */
  description?: string;
  requires_python?: string | null;
  entry_points: PluginEntryPointInfo[];
  exchange_capabilities: PluginExchangeCapabilityInfo[];
  project_urls: PluginLinkInfo[];
  home_page?: string | null;
  author?: string | null;
  yanked: boolean;
  yanked_reason?: string | null;
  first_seen_at?: string | null;
  last_checked_at?: string | null;
}

export interface PluginIndexSnapshot {
  schema_version: number;
  generated_at: string;
  count: number;
  plugins: PluginListItem[];
}

export type PluginIndexResult =
  | { kind: 'ok'; snapshot: PluginIndexSnapshot; etag?: string }
  | { kind: 'not-modified' };

const TIMEOUT_MS = 15000;

async function get(
  baseUrl: string,
  path: string,
  headers: Record<string, string>
): Promise<{ status: number; text: string; etag?: string }> {
  const url = baseUrl.replace(/\/$/, '') + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'PyneIDE', ...headers },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`Request timed out after ${TIMEOUT_MS} ms`);
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
  return { status: res.status, text: await res.text(), etag: res.headers.get('etag') ?? undefined };
}

/** Fetch the whole index, conditionally when a previous ETag is known. */
export async function fetchPluginIndex(
  baseUrl: string,
  etag?: string
): Promise<PluginIndexResult> {
  const res = await get(baseUrl, '/plugins/index.json', etag ? { 'If-None-Match': etag } : {});
  if (res.status === 304) return { kind: 'not-modified' };
  if (res.status !== 200) {
    throw new Error(`Plugin index request failed (HTTP ${res.status})`);
  }
  let snapshot: PluginIndexSnapshot;
  try {
    snapshot = JSON.parse(res.text) as PluginIndexSnapshot;
  } catch {
    throw new Error(`Plugin index returned an unparseable body (${res.text.length} bytes)`);
  }
  if (!Array.isArray(snapshot.plugins)) snapshot.plugins = [];
  return { kind: 'ok', snapshot, etag: res.etag };
}

/** Everything the index knows about one package (the detail pane's source). */
export async function fetchPluginDetail(baseUrl: string, pkg: string): Promise<PluginDetail> {
  const res = await get(baseUrl, `/plugins/${encodeURIComponent(pkg)}`, {});
  if (res.status === 404) throw new Error(`${pkg} is not in the plugin index`);
  if (res.status !== 200) throw new Error(`Plugin lookup failed (HTTP ${res.status})`);
  try {
    return JSON.parse(res.text) as PluginDetail;
  } catch {
    throw new Error(`Plugin lookup returned an unparseable body (${res.text.length} bytes)`);
  }
}

/** PEP 503 normalization, so `PyneSys_PyneCore-Bybit` matches the index key. */
export function normalizePackageName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Whether an installed PyneCore satisfies a plugin's declared floor. Unknown
 * values (an index entry without `min_pynecore`, or an unverifiable env) pass:
 * the check exists to stop a doomed install, not to invent one.
 */
export function satisfiesMinPynecore(min: string | undefined, installed: string | undefined): boolean {
  if (!min || !installed) return true;
  return compareVersions(installed, min) >= 0;
}
