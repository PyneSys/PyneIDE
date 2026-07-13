/**
 * Client for the PyneSys API. Mirrors the contract of pynecore's
 * pynesys/api.py client: form-encoded compile, plain-text Python response,
 * error envelope {"detail": {status, error, line, file}}.
 *
 * Uses the global fetch (undici) rather than node:http(s): the VSCode extension
 * host proxy-patches node:http(s) (@vscode/proxy-agent), and that patch drops
 * the body of Cloudflare's chunked responses — a 200 arrives with an empty
 * body. fetch runs on a separate stack; the host still gives it proxy and
 * system-certificate support via the http.fetchAdditionalSupport setting
 * (on by default), so nothing regresses for proxy users. See
 * microsoft/vscode#173861.
 */

export const DEFAULT_API_BASE_URL = 'https://api.pynesys.io';

export interface CompileErrorDetail {
  error: string;
  line?: number;
  file?: string;
}

export type CompileResult =
  | { ok: true; code: string }
  | {
      ok: false;
      status: number;
      detail: CompileErrorDetail;
      retryAfterSeconds?: number;
    };

export interface UsagePeriod {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
}

export interface Usage {
  daily: UsagePeriod;
  hourly: UsagePeriod;
}

export interface TokenVerification {
  valid: boolean;
  message: string;
  expiresAt?: string;
}

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

// Response headers worth logging when diagnosing an empty/truncated body:
// they reveal a proxy or CDN sitting between the extension host and the API.
const DIAGNOSTIC_HEADERS = [
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'server',
  'via',
  'x-cache',
  'cf-ray',
];

export class PyneApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_API_BASE_URL,
    private readonly log: (message: string) => void = () => {}
  ) {}

  private async request(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: string; contentType?: string; auth?: boolean; timeoutMs?: number } = {}
  ): Promise<HttpResponse> {
    const { body, contentType, auth = true, timeoutMs = 30000 } = options;
    const url = this.baseUrl.replace(/\/$/, '') + path;
    const headers: Record<string, string> = { 'User-Agent': 'PyneIDE' };
    if (auth) headers.Authorization = `Bearer ${this.apiKey}`;
    if (contentType) headers['Content-Type'] = contentType;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Request timed out after ${timeoutMs} ms`);
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => (responseHeaders[key] = value));
    const response: HttpResponse = { status: res.status, headers: responseHeaders, text };
    this.logResponse(method, path, response);
    return response;
  }

  /** Log status, body size and proxy-relevant headers (never the query string, which carries the token). */
  private logResponse(method: 'GET' | 'POST', path: string, res: HttpResponse): void {
    const relevant = DIAGNOSTIC_HEADERS.filter((k) => res.headers[k] !== undefined)
      .map((k) => `${k}=${String(res.headers[k])}`)
      .join(', ');
    this.log(
      `${method} ${path.split('?')[0]} -> HTTP ${res.status}, body ${res.text.length} bytes` +
        (relevant ? ` [${relevant}]` : '')
    );
  }

  /** Parse a JSON body, turning the cryptic "Unexpected end of JSON input" into a diagnostic error. */
  private static parseJson<T>(res: HttpResponse, context: string): T {
    try {
      return JSON.parse(res.text) as T;
    } catch {
      const snippet = res.text.length > 200 ? `${res.text.slice(0, 200)}…` : res.text;
      throw new Error(
        `${context}: HTTP ${res.status} with an unparseable body ` +
          `(${res.text.length} bytes). Body: ${JSON.stringify(snippet)}`
      );
    }
  }

  /** Extract the error detail from an error response body. */
  private static parseErrorDetail(text: string, status: number): CompileErrorDetail {
    try {
      const data = JSON.parse(text) as { detail?: unknown; message?: string };
      if (data.detail && typeof data.detail === 'object' && !Array.isArray(data.detail)) {
        const d = data.detail as { error?: string; line?: number; file?: string };
        return { error: d.error ?? text, line: d.line ?? undefined, file: d.file ?? undefined };
      }
      if (Array.isArray(data.detail)) {
        // FastAPI validation error list (422)
        const messages = data.detail
          .map((item) => (typeof item === 'object' && item && 'msg' in item ? String(item.msg) : ''))
          .filter(Boolean);
        return { error: messages.join('; ') || text };
      }
      if (typeof data.detail === 'string') return { error: data.detail };
      if (data.message) return { error: data.message };
    } catch {
      // Not JSON — fall through
    }
    return { error: text.trim() || `HTTP ${status} error` };
  }

  async compile(script: string, strict: boolean): Promise<CompileResult> {
    const body = new URLSearchParams({ script, strict: String(strict) }).toString();
    const res = await this.request('POST', '/compiler/compile', {
      body,
      contentType: 'application/x-www-form-urlencoded',
      timeoutMs: 60000,
    });
    if (res.status === 200) {
      return { ok: true, code: res.text };
    }
    const retryAfter = res.headers['retry-after'];
    return {
      ok: false,
      status: res.status,
      detail: PyneApiClient.parseErrorDetail(res.text, res.status),
      retryAfterSeconds: retryAfter ? parseInt(String(retryAfter), 10) || undefined : undefined,
    };
  }

  async usage(): Promise<Usage> {
    const res = await this.request('GET', '/account/usage');
    if (res.status !== 200) {
      throw new Error(
        `Failed to fetch usage (HTTP ${res.status}): ` +
          PyneApiClient.parseErrorDetail(res.text, res.status).error
      );
    }
    const data = PyneApiClient.parseJson<{
      daily: { limit: number; used: number; remaining: number; reset_at: string };
      hourly: { limit: number; used: number; remaining: number; reset_at: string };
    }>(res, 'account/usage');
    const period = (p: typeof data.daily): UsagePeriod => ({
      limit: p.limit,
      used: p.used,
      remaining: p.remaining,
      resetAt: p.reset_at,
    });
    return { daily: period(data.daily), hourly: period(data.hourly) };
  }

  /** Server-side token verification (also works before storing the key). */
  async verifyToken(token: string): Promise<TokenVerification> {
    const res = await this.request(
      'GET',
      `/auth/verify-token?token=${encodeURIComponent(token)}`,
      { auth: false }
    );
    if (res.status !== 200) {
      return {
        valid: false,
        message: PyneApiClient.parseErrorDetail(res.text, res.status).error,
      };
    }
    const data = PyneApiClient.parseJson<{
      valid: boolean;
      message?: string;
      expires_at?: string;
    }>(res, 'auth/verify-token');
    return {
      valid: data.valid,
      message: data.message ?? '',
      expiresAt: data.expires_at ?? undefined,
    };
  }
}
