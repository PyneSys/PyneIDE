/**
 * Pine access panel (viewType `pyneide.pineAccess`): what compiling Pine
 * Script needs, the current plans from `/system/pricing`, and a key field.
 *
 * It opens wherever a Pine compile is blocked on the account — no key, no
 * active subscription, a reached compile limit — and from the walkthrough and
 * the status menu. The plans are fetched, never bundled: they change.
 *
 * One panel per window: a second `show()` re-renders it for the new reason.
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { flattenErrorMessage } from '../net/errors';
import type { AuthService } from './auth';
import { APP_URL, type PricingPlan } from './client';

export type AccessReason = 'signin' | 'subscription' | 'limit' | 'browse';

export interface AccessOptions {
  reason: AccessReason;
  /** The .pine whose compile was blocked: offered as "Run again" once connected. */
  script?: vscode.Uri;
  /** The API's own message (limit and subscription errors). */
  detail?: string;
}

const SUBSCRIPTION_URL = `${APP_URL}/subscription`;
const API_KEYS_URL = `${APP_URL}/api-keys`;
/** Signs in when needed, then highlights the plan on the subscription page. */
const signupUrl = (plan: string): string =>
  `${APP_URL}/signup?plan=${encodeURIComponent(plan.toLowerCase())}`;

/*
 * Seed and Sprout are for bringing Pine over to Pyne code, Grower and Forest for developing
 * in Pine every day; the hourly limits draw that line. Same grouping as on pynesys.io and in
 * the web app.
 */
const PLAN_GROUPS = [
  {
    title: 'Bring your Pine over',
    text: 'Convert a few scripts, then keep working on the Pyne code for free.',
    plans: ['Seed', 'Sprout'],
  },
  {
    title: 'Keep developing in Pine',
    text: 'For running and debugging Pine Script in PyneIDE every day.',
    plans: ['Grower', 'Forest'],
  },
];

/**
 * Split the plans into the use-case groups; plans that no group lists are kept in a trailing
 * untitled group, so a new plan from the API never disappears from the panel.
 */
function groupPlans(plans: PricingPlan[]): { title: string; text: string; plans: PricingPlan[] }[] {
  const groups = PLAN_GROUPS.map((group) => ({
    ...group,
    plans: plans.filter((plan) => group.plans.includes(plan.name)),
  })).filter((group) => group.plans.length > 0);
  const grouped = new Set(PLAN_GROUPS.flatMap((group) => group.plans));
  const rest = plans.filter((plan) => !grouped.has(plan.name));
  if (rest.length > 0) groups.push({ title: '', text: '', plans: rest });
  return groups;
}

type InMessage =
  | { type: 'open'; url: string }
  | { type: 'connect'; key: string }
  | { type: 'useCliKey' }
  | { type: 'run' };

const compiles = (count: number): string => `${count} compile${count === 1 ? '' : 's'}`;

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class PineAccessPanel {
  private static current: PineAccessPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private plans: PricingPlan[] | undefined;
  private plansError: string | undefined;
  private connected: { expiry?: Date } | undefined;

  static show(context: vscode.ExtensionContext, auth: AuthService, options: AccessOptions): void {
    const existing = PineAccessPanel.current;
    if (existing) {
      // Opened again from a menu: the blocked script is still worth offering.
      existing.options = { ...options, script: options.script ?? existing.options.script };
      existing.connected = undefined;
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.render();
      return;
    }
    PineAccessPanel.current = new PineAccessPanel(context, auth, options);
  }

  private constructor(
    context: vscode.ExtensionContext,
    private readonly auth: AuthService,
    private options: AccessOptions
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'pyneide.pineAccess',
      'Pine Script in PyneIDE',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [] }
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icons', 'pyne-core.svg');
    this.panel.webview.onDidReceiveMessage(
      (msg: InMessage) => void this.onMessage(msg),
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    void this.render();
  }

  private async render(): Promise<void> {
    if (!this.plans) {
      this.panel.webview.html = this.html('<p class="muted">Loading plans…</p>');
      try {
        this.plans = await this.auth.pricing();
        this.plansError = undefined;
      } catch (err) {
        this.plansError = flattenErrorMessage(err);
      }
    }
    const signedIn = (await this.auth.getKey()) !== undefined;
    this.panel.webview.html = this.html(this.body(signedIn));
  }

  private async onMessage(msg: InMessage): Promise<void> {
    switch (msg.type) {
      case 'open':
        // Only the PyneSys app pages this panel links to.
        if (msg.url.startsWith(`${APP_URL}/`)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        break;
      case 'connect':
        await this.connect(msg.key.trim());
        break;
      case 'useCliKey': {
        const key = this.auth.cliKey();
        if (key) await this.connect(key);
        break;
      }
      case 'run':
        if (this.options.script) {
          const script = this.options.script;
          this.panel.dispose();
          await vscode.commands.executeCommand('pyneide.runPineScript', script);
        }
        break;
    }
  }

  private async connect(key: string): Promise<void> {
    if (!key) {
      void this.panel.webview.postMessage({ type: 'error', message: 'Paste an API key first.' });
      return;
    }
    void this.panel.webview.postMessage({ type: 'busy' });
    try {
      const verification = await this.auth.verifyKey(key);
      if (!verification.valid) {
        void this.panel.webview.postMessage({
          type: 'error',
          message: `This API key is not valid: ${verification.message}`,
        });
        return;
      }
      this.connected = { expiry: await this.auth.storeKey(key, verification) };
      await this.render();
    } catch (err) {
      void this.panel.webview.postMessage({
        type: 'error',
        message: `Could not reach PyneSys to check the key: ${flattenErrorMessage(err)}`,
      });
    }
  }

  private body(signedIn: boolean): string {
    const { reason, detail, script } = this.options;
    const scriptName = script ? escapeHtml(path.basename(script.fsPath)) : undefined;
    const parts: string[] = [];

    if (this.connected) {
      const expiry = this.connected.expiry
        ? ` The key expires ${this.connected.expiry.toISOString().slice(0, 10)}.`
        : '';
      parts.push(
        '<h1>Connected to PyneSys</h1>',
        `<p class="lead">✓ Your API key is stored. Pine Script compiles from now on.${expiry}</p>`,
        scriptName
          ? `<p><button data-action="run">Run ${scriptName}</button></p>`
          : '<p class="muted">Run any .pine file with Run Pine Script.</p>'
      );
      return parts.join('\n');
    }

    if (reason === 'subscription') {
      parts.push(
        '<h1>Your account has no active plan</h1>',
        '<p class="lead">Compiling Pine Script needs an active PyneSys plan. Choose one below, ' +
          `then run ${scriptName ?? 'your script'} again.</p>`
      );
    } else if (reason === 'limit') {
      parts.push(
        '<h1>Compile limit reached</h1>',
        `<p class="lead">${escapeHtml(detail ?? 'Your plan’s compile limit is used up.')} ` +
          'A larger plan raises the hourly and daily limits.</p>',
        '<p class="muted">Until then, every Pine script you already compiled keeps running, and ' +
          'its generated Pyne code (the .py next to it) runs and debugs without compiling.</p>'
      );
    } else {
      parts.push(
        '<h1>Run your own Pine Script</h1>',
        '<p class="lead">The demo scripts in <code>scripts/</code> run and debug without an ' +
          'account. Your own Pine Script' +
          (reason === 'signin' ? ', or an edited demo,' : '') +
          ' is compiled by the PyneSys compiler: that needs a plan and an API key.</p>'
      );
    }

    if (!signedIn) {
      const cliKey = this.auth.cliKey() !== undefined;
      parts.push(
        '<ol class="steps">',
        '<li><b>Choose a plan</b> from the list below. The PyneSys web app opens in your ' +
          'browser to sign in and pay; this panel stays open for the next steps.</li>',
        `<li><b>Create an API key</b> on the <a data-url="${API_KEYS_URL}">API Keys page</a>.</li>`,
        '<li><b>Paste the key here</b>:',
        '<div class="key-row">',
        '<input id="key" type="password" placeholder="PyneSys API key" autocomplete="off" spellcheck="false">',
        '<button data-action="connect">Connect</button>',
        '</div>',
        cliKey
          ? '<p class="muted">Already used the pyne CLI here? ' +
            '<a data-action="useCliKey">Use the key from config/api.toml</a></p>'
          : '',
        '<p id="message" class="message"></p>',
        '</li>',
        '</ol>'
      );
    }

    parts.push('<h2>Plans</h2>', this.plansHtml());
    if (signedIn) {
      parts.push(`<p class="muted"><a data-url="${SUBSCRIPTION_URL}">Manage your subscription</a></p>`);
    }
    return parts.join('\n');
  }

  private plansHtml(): string {
    if (!this.plans) {
      return (
        `<p class="message error">The plans could not be loaded (${escapeHtml(this.plansError ?? '')}).` +
        ` See them on the <a data-url="${SUBSCRIPTION_URL}">subscription page</a>.</p>`
      );
    }
    const card = (plan: PricingPlan): string => {
      const name = escapeHtml(plan.name);
      return [
        `<div class="plan${plan.primary ? ' primary' : ''}">`,
        `<div class="plan-name">${name}${plan.primary ? ' <span class="badge">Recommended</span>' : ''}</div>`,
        `<div class="price">${escapeHtml(plan.priceDisplay)}<span>/month</span></div>`,
        '<ul class="limits">',
        `<li>${compiles(plan.hourlyLimit)} per hour</li>`,
        `<li>${compiles(plan.dailyLimit)} per day</li>`,
        `<li>Scripts up to ${plan.maxScriptSizeKB} KB</li>`,
        '</ul>',
        `<p class="desc">${escapeHtml(plan.description)}</p>`,
        `<button class="${plan.primary ? '' : 'secondary'}" data-url="${signupUrl(plan.name)}">Choose ${name}</button>`,
        '</div>',
      ].join('\n');
    };
    const groups = groupPlans(this.plans).map((group) =>
      [
        '<div class="group">',
        group.title ? `<h3>${escapeHtml(group.title)}</h3><p class="muted">${escapeHtml(group.text)}</p>` : '',
        `<div class="plans">${group.plans.map(card).join('\n')}</div>`,
        '</div>',
      ].join('\n')
    );
    return `<div class="groups">${groups.join('\n')}</div>` + this.comparisonHtml(this.plans);
  }

  /** The plan comparison table and its notes, as on pynesys.io. */
  private comparisonHtml(plans: PricingPlan[]): string {
    const row = (label: string, value: (plan: PricingPlan) => string): string =>
      `<tr><th scope="row">${label}</th>` +
      plans.map((plan) => `<td${plan.primary ? ' class="primary"' : ''}>${value(plan)}</td>`).join('') +
      '</tr>';
    return [
      '<h2>Plan comparison</h2>',
      '<table class="compare">',
      '<thead><tr><th scope="col" aria-label="Feature"></th>' +
        plans.map((plan) => `<th scope="col"${plan.primary ? ' class="primary"' : ''}>${escapeHtml(plan.name)}</th>`).join('') +
        '</tr></thead>',
      '<tbody>',
      row('Price', (plan) => `${escapeHtml(plan.priceDisplay)}/month`),
      row('Pine compiles per day', (plan) => String(plan.dailyLimit)),
      row('Pine compiles per hour', (plan) => String(plan.hourlyLimit)),
      row('API keys', (plan) => String(plan.apiKeys)),
      row('Max script size', (plan) => `${plan.maxScriptSizeKB} KB`),
      '</tbody>',
      '</table>',
      '<ul class="notes muted">',
      '<li>Each run of a changed <code>.pine</code> file is one compile. Unchanged scripts come from ' +
        'the cache and don’t count.</li>',
      '<li>Converting a Pine v4 or v5 script to v6 doesn’t use your quota.</li>',
      '<li>The generated Pyne code is yours to read, edit and keep.</li>',
      '</ul>',
    ].join('\n');
  }

  private html(body: string): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-size: 13px; line-height: 1.5;
    max-width: 1080px; margin: 0 auto; padding: 20px 24px 40px;
  }
  h1 { font-size: 20px; margin: 4px 0 6px; }
  h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600;
    color: var(--vscode-descriptionForeground); margin: 26px 0 10px;
  }
  .lead { font-size: 14px; margin: 0 0 12px; }
  .muted { color: var(--vscode-descriptionForeground); }
  code { font-family: var(--vscode-editor-font-family, monospace); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .steps { padding-left: 20px; margin: 14px 0; }
  .steps li { margin: 8px 0; }
  .key-row { display: flex; gap: 8px; margin-top: 6px; max-width: 560px; }
  input {
    flex: 1 1 auto; box-sizing: border-box; height: 30px; padding: 4px 8px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 2px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
  }
  button {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none; border-radius: 3px; cursor: pointer; padding: 4px 14px;
    font-size: 13px; height: 30px; white-space: nowrap;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #1177bb); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, #444);
  }
  .message { min-height: 1em; margin: 6px 0 0; }
  .message.error { color: var(--vscode-errorForeground, #f48771); }
  /* The groups sit side by side when both fit, as on pynesys.io, and stack otherwise. */
  .groups { display: flex; flex-wrap: wrap; gap: 18px 24px; }
  .group { flex: 1 1 440px; display: flex; flex-direction: column; }
  .group h3 { font-size: 14px; margin: 0 0 2px; }
  .group > p { margin: 0 0 10px; }
  .plans { flex: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
  .compare { border-collapse: collapse; width: 100%; max-width: 760px; }
  .compare th, .compare td {
    padding: 6px 10px; text-align: center;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
  }
  .compare th[scope="row"] { text-align: left; font-weight: 400; color: var(--vscode-descriptionForeground); }
  .compare thead th { font-weight: 600; }
  .compare .primary { background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.1)); }
  .notes { padding-left: 18px; margin: 10px 0 0; max-width: 760px; }
  .notes li { margin: 3px 0; }
  .plan {
    display: flex; flex-direction: column; gap: 4px; padding: 14px;
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px;
  }
  .plan.primary { border-color: var(--vscode-focusBorder, #0e639c); }
  .plan button { margin-top: auto; }
  .badge {
    vertical-align: middle; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 3px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .plan-name { font-size: 15px; font-weight: 600; }
  .price { font-size: 22px; font-weight: 600; }
  .price span { font-size: 12px; font-weight: 400; color: var(--vscode-descriptionForeground); }
  .limits { margin: 4px 0; padding-left: 16px; }
  .desc { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 4px 0 10px; }
</style>
</head>
<body>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const key = document.getElementById('key');
  const message = document.getElementById('message');
  const connect = () => vscode.postMessage({ type: 'connect', key: key ? key.value : '' });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-url], [data-action]');
    if (!el) return;
    if (el.dataset.url) vscode.postMessage({ type: 'open', url: el.dataset.url });
    else if (el.dataset.action === 'connect') connect();
    else vscode.postMessage({ type: el.dataset.action });
  });
  if (key) key.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  window.addEventListener('message', (e) => {
    const msg = e.data;
    const button = document.querySelector('[data-action="connect"]');
    if (msg.type === 'busy') {
      if (button) button.disabled = true;
      if (message) { message.className = 'message muted'; message.textContent = 'Checking the key…'; }
    } else if (msg.type === 'error') {
      if (button) button.disabled = false;
      if (message) { message.className = 'message error'; message.textContent = msg.message; }
    }
  });
</script>
</body>
</html>`;
  }

  private dispose(): void {
    PineAccessPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
