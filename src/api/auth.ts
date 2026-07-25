import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import { DEFAULT_API_BASE_URL, PyneApiClient } from './client';

const SECRET_KEY = 'pynesys.apiKey';
const KEYS_PAGE_URL = 'https://app.pynesys.io';

/** Decode a JWT payload locally (no verification) to read the expiry claim. */
export function jwtExpiry(token: string): Date | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      exp?: number;
      e?: number;
    };
    const exp = payload.exp ?? payload.e;
    return exp ? new Date(exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

/** Read the API key from a pynecore CLI config (workdir/config/api.toml). */
function readApiTomlKey(workdir: string): string | undefined {
  const tomlPath = path.join(workdir, 'config', 'api.toml');
  try {
    const content = fs.readFileSync(tomlPath, 'utf8');
    // Minimal parse: api_key = "..." under [api]; enough for the CLI's own format.
    const match = content.match(/^\s*api_key\s*=\s*["']([^"']+)["']/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export class AuthService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  private log = (message: string): void => {
    this.output.appendLine(message);
  };

  baseUrl(): string {
    return (
      vscode.workspace.getConfiguration('pyneide').get<string>('apiBaseUrl')?.trim() ||
      DEFAULT_API_BASE_URL
    );
  }

  async getKey(): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_KEY);
  }

  async client(): Promise<PyneApiClient | undefined> {
    const key = await this.getKey();
    return key ? new PyneApiClient(key, this.baseUrl(), this.log) : undefined;
  }

  /**
   * Client for sending a problem report. Reporting must work signed out too,
   * so a missing key is not an error here — it only means the report goes out
   * anonymously (`authenticated: false`, and the caller skips the auth header).
   */
  async reportClient(): Promise<{ client: PyneApiClient; authenticated: boolean }> {
    const key = await this.getKey();
    return {
      client: new PyneApiClient(key ?? '', this.baseUrl(), this.log),
      authenticated: key !== undefined,
    };
  }

  /**
   * Interactive sign-in: paste (or import) an API key, validate it, store it
   * in SecretStorage. Returns true when a valid key is stored.
   */
  async signIn(): Promise<boolean> {
    let initialValue = '';
    const workdir = resolveWorkspaceWorkdir();
    const cliKey = workdir?.exists ? readApiTomlKey(workdir.path) : undefined;
    if (cliKey) {
      const choice = await vscode.window.showInformationMessage(
        'PyneIDE: found an API key in workdir/config/api.toml (pyne CLI). Use it?',
        'Use CLI Key',
        'Enter Manually'
      );
      if (choice === undefined) return false;
      if (choice === 'Use CLI Key') initialValue = cliKey;
    }

    const key = await vscode.window.showInputBox({
      title: 'PyneSys API Key',
      prompt: `Paste your PyneSys API key (create one at ${KEYS_PAGE_URL})`,
      value: initialValue,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'API key must not be empty'),
    });
    if (!key) return false;

    const trimmed = key.trim();
    const client = new PyneApiClient(trimmed, this.baseUrl(), this.log);
    let verification;
    try {
      verification = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'PyneIDE: validating API key…' },
        () => client.verifyToken(trimmed)
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Key validation failed: ${message}`);
      void vscode.window.showErrorMessage(
        `PyneIDE: could not validate the API key: ${message}`
      );
      return false;
    }
    if (!verification.valid) {
      void vscode.window.showErrorMessage(
        `PyneIDE: the API key is not valid: ${verification.message}`
      );
      return false;
    }

    await this.context.secrets.store(SECRET_KEY, trimmed);
    const expiry = verification.expiresAt
      ? new Date(verification.expiresAt)
      : jwtExpiry(trimmed);
    void vscode.window.showInformationMessage(
      'PyneIDE: signed in to PyneSys.' +
        (expiry ? ` API key expires ${expiry.toISOString().slice(0, 10)}.` : '')
    );
    return true;
  }

  async signOut(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    void vscode.window.showInformationMessage('PyneIDE: signed out, API key removed.');
  }

  /** Get a client, prompting for sign-in when there is no stored key. */
  async requireClient(): Promise<PyneApiClient | undefined> {
    const existing = await this.client();
    if (existing) return existing;
    const choice = await vscode.window.showInformationMessage(
      'PyneIDE: compiling Pine Script requires a PyneSys API key.',
      'Sign In'
    );
    if (choice !== 'Sign In') return undefined;
    if (!(await this.signIn())) return undefined;
    return this.client();
  }
}
