import * as https from 'node:https';
import * as http from 'node:http';

/**
 * Client for the PyneSys API. Mirrors the contract of pynecore's
 * pynesys/api.py client: form-encoded compile, plain-text Python response,
 * error envelope {"detail": {status, error, line, file}}.
 *
 * Uses node:http(s), which the VSCode extension host proxy-patches, so the
 * user's http.proxy settings apply.
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
  headers: http.IncomingHttpHeaders;
  text: string;
}

export class PyneApiClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_API_BASE_URL
  ) {}

  private request(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: string; contentType?: string; auth?: boolean; timeoutMs?: number } = {}
  ): Promise<HttpResponse> {
    const { body, contentType, auth = true, timeoutMs = 30000 } = options;
    const url = new URL(this.baseUrl.replace(/\/$/, '') + path);
    const headers: Record<string, string> = { 'User-Agent': 'PyneIDE' };
    if (auth) headers.Authorization = `Bearer ${this.apiKey}`;
    if (contentType) headers['Content-Type'] = contentType;
    if (body) headers['Content-Length'] = String(Buffer.byteLength(body));

    return new Promise((resolve, reject) => {
      const req = https.request(url, { method, headers, timeout: timeoutMs }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
        res.on('error', reject);
      });
      req.on('timeout', () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs} ms`));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
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
    const data = JSON.parse(res.text) as {
      daily: { limit: number; used: number; remaining: number; reset_at: string };
      hourly: { limit: number; used: number; remaining: number; reset_at: string };
    };
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
    const data = JSON.parse(res.text) as {
      valid: boolean;
      message?: string;
      expires_at?: string;
    };
    return {
      valid: data.valid,
      message: data.message ?? '',
      expiresAt: data.expires_at ?? undefined,
    };
  }
}
