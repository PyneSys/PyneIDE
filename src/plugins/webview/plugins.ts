/**
 * Plugins panel webview: renders the merged catalogue/installed model, filters
 * it locally (the index is a single small document), and posts intents back to
 * the host. It owns no data of its own beyond the selection and the filters —
 * every model change arrives as a whole new model.
 */
import type { PluginDetail } from '../catalog';
import { docstringParagraphs } from '../docstring';
import type { PluginsInMessage, PluginsOutMessage } from '../messages';
import type { PluginRow, PluginsModel } from '../service';

interface VsCodeApi {
  postMessage(message: PluginsOutMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const listEl = el<HTMLDivElement>('list');
const detailEl = el<HTMLDivElement>('detail');
const statusEl = el<HTMLDivElement>('status');
const searchEl = el<HTMLInputElement>('search');

let model: PluginsModel | undefined;
let selected: string | undefined;
let busy: string | undefined;
let loading = true;
const details = new Map<string, { detail?: PluginDetail; error?: string }>();
const actionErrors = new Map<string, string>();
const filters = new Set<string>();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

function matches(row: PluginRow): boolean {
  const query = searchEl.value.trim().toLowerCase();
  if (query) {
    const haystack = [row.package, row.displayName, row.summary, ...row.pluginIds]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  for (const filter of filters) {
    if (filter === 'installed') {
      if (!row.installed) return false;
    } else if (!row.capabilities.includes(filter)) {
      // `provider` also covers live providers, which are providers by hierarchy.
      if (!(filter === 'provider' && row.capabilities.includes('live_provider'))) return false;
    }
  }
  return true;
}

function badges(row: PluginRow): string {
  const items: string[] = [];
  if (row.builtin) items.push('<span class="badge">built-in</span>');
  else if (row.tier) items.push(`<span class="badge ${row.tier}">${row.tier}</span>`);
  if (row.installed) {
    items.push(
      `<span class="badge installed">installed${row.installedVersion ? ` ${escapeHtml(row.installedVersion)}` : ''}</span>`
    );
  }
  if (row.updateAvailable) {
    items.push(`<span class="badge update">update ${escapeHtml(row.latestVersion ?? '')}</span>`);
  }
  if (row.status === 'yanked') items.push('<span class="badge warn">yanked</span>');
  if (row.conflict) items.push('<span class="badge warn">name conflict</span>');
  return `<span class="badges">${items.join('')}</span>`;
}

function rowHtml(row: PluginRow): string {
  const version = row.installedVersion ?? row.latestVersion ?? '';
  return `<div class="row${row.id === selected ? ' sel' : ''}" data-row="${escapeHtml(row.id)}">
  <div class="row-head">
    <span class="name">${escapeHtml(row.displayName)}</span>
    <span class="pkg mono">${escapeHtml(row.package)}${version ? ` ${escapeHtml(version)}` : ''}</span>
  </div>
  <div class="row-summary">${escapeHtml(row.summary || 'No summary available.')}</div>
  <div class="row-summary">${badges(row)}</div>
</div>`;
}

function renderStatus(): void {
  if (!model) {
    statusEl.textContent = loading ? 'Loading…' : '';
    statusEl.className = '';
    return;
  }
  const parts: string[] = [];
  let severity = '';
  if (model.catalogue.state === 'error') {
    parts.push(`Catalogue unavailable — ${model.catalogue.message ?? 'unknown error'}`);
    severity = 'error';
  } else if (model.catalogue.state === 'cached') {
    parts.push(
      `Offline — showing the copy cached ${model.catalogue.fetchedAt ? new Date(model.catalogue.fetchedAt).toLocaleString() : 'earlier'}`
    );
    severity = 'warn';
  }
  if (!model.env.installedKnown) {
    parts.push(`Installed state unknown${model.env.installedMessage ? ` (${model.env.installedMessage})` : ''}`);
    severity = severity || 'warn';
  } else if (model.env.pynecoreVersion) {
    parts.push(`PyneCore ${model.env.pynecoreVersion}`);
  }
  if (!model.env.managed) {
    parts.push('custom environment: install commands are copied, not run');
    severity = severity || 'warn';
  }
  if (loading) parts.unshift('Loading…');
  statusEl.textContent = parts.join(' · ');
  statusEl.className = severity;
}

function renderList(): void {
  if (!model) {
    listEl.innerHTML = '<div class="empty">Loading…</div>';
    return;
  }
  const visible = model.rows.filter(matches);
  if (visible.length === 0) {
    listEl.innerHTML = '<div class="empty">No plugins match the current filters.</div>';
    return;
  }
  const catalogue = visible.filter((r) => r.inCatalogue);
  const local = visible.filter((r) => !r.inCatalogue);
  const chunks: string[] = [];
  if (catalogue.length) chunks.push(catalogue.map(rowHtml).join(''));
  if (local.length) {
    chunks.push(
      '<h2 class="section">Installed, not in the catalogue</h2>',
      local.map(rowHtml).join('')
    );
  }
  listEl.innerHTML = chunks.join('');
}

function actionsHtml(row: PluginRow): string {
  if (row.builtin) {
    return '<div class="note">Ships with PyneCore — always available, nothing to install.</div>';
  }
  const running = busy === row.id;
  const disabled = running || busy !== undefined ? ' disabled' : '';
  const buttons: string[] = [];
  if (!model?.env.managed) {
    buttons.push('<button id="copy" class="secondary" type="button">Copy install command</button>');
  } else if (row.inCatalogue && !row.installed) {
    buttons.push(
      `<button id="install" type="button"${row.blockedReason ? ' disabled' : disabled}>${running ? 'Installing…' : 'Install'}</button>`
    );
  } else if (row.updateAvailable) {
    buttons.push(
      `<button id="install" type="button"${disabled}>${running ? 'Updating…' : `Update to ${escapeHtml(row.latestVersion ?? '')}`}</button>`
    );
  }
  if (row.installed && model?.env.managed) {
    buttons.push(
      `<button id="uninstall" class="secondary" type="button"${disabled}>${running ? 'Working…' : 'Uninstall'}</button>`
    );
  }
  const notes: string[] = [];
  if (!model?.env.managed) {
    notes.push(
      '<div class="note">PyneIDE never installs into a custom environment ' +
        '(<span class="mono">pyneide.venvPath</span> / <span class="mono">pyneide.pythonPath</span>) — ' +
        'run the copied command inside it yourself.</div>'
    );
  }
  if (row.blockedReason) notes.push(`<div class="note blocked">${escapeHtml(row.blockedReason)}</div>`);
  const error = actionErrors.get(row.id);
  if (error) notes.push(`<div class="note error">${escapeHtml(error)}</div>`);
  return `<div id="actions">${buttons.join('')}</div>${notes.join('')}`;
}

function detailHtml(row: PluginRow): string {
  const entry = details.get(row.id);
  const detail = entry?.detail;
  const rows: string[] = [
    metaRow('Package', `<span class="mono">${escapeHtml(row.package)}</span>`),
    metaRow('Plugin id', row.pluginIds.map(escapeHtml).join(', ') || '—'),
    metaRow('Capabilities', row.capabilities.map(escapeHtml).join(', ') || '—'),
  ];
  if (row.latestVersion) rows.push(metaRow('Latest version', escapeHtml(row.latestVersion)));
  if (row.installedVersion) rows.push(metaRow('Installed version', escapeHtml(row.installedVersion)));
  if (row.requiresPynecore) rows.push(metaRow('Requires PyneCore', escapeHtml(row.requiresPynecore)));
  if (detail?.requires_python) rows.push(metaRow('Requires Python', escapeHtml(detail.requires_python)));
  if (detail?.author) rows.push(metaRow('Author', escapeHtml(detail.author)));
  if (row.inCatalogue) {
    rows.push(metaRow('Updated', fmtDate(row.updatedAt)));
    rows.push(
      metaRow(
        'Downloads (30d)',
        row.downloads30d === null || row.downloads30d === undefined
          ? '—'
          : String(row.downloads30d)
      )
    );
  }

  const sections: string[] = [
    `<h1>${escapeHtml(row.displayName)}</h1>`,
    `<div class="sub">${badges(row)}</div>`,
    `<p>${escapeHtml(row.summary || 'No summary available.')}</p>`,
    actionsHtml(row),
    '<h3>Details</h3>',
    `<table class="meta">${rows.join('')}</table>`,
  ];

  if (detail?.description?.trim()) {
    sections.push('<h3>Description</h3>', descriptionHtml(detail.description));
  }
  if (detail?.yanked && detail.yanked_reason) {
    sections.push(`<div class="note error">Yanked: ${escapeHtml(detail.yanked_reason)}</div>`);
  }
  if (detail?.entry_points?.length) {
    sections.push(
      '<h3>Entry points</h3>',
      `<table class="meta">${detail.entry_points
        .map((ep) => metaRow(escapeHtml(ep.name), `<span class="mono">${escapeHtml(ep.value)}</span>`))
        .join('')}</table>`
    );
  }
  if (detail?.exchange_capabilities?.length) {
    sections.push(
      '<h3>Exchange capabilities</h3>',
      `<table class="meta">${detail.exchange_capabilities
        .map((cap) =>
          metaRow(escapeHtml(cap.name), escapeHtml(cap.level + (cap.varies ? ' (varies)' : '')))
        )
        .join('')}</table>`
    );
  }
  const links = [
    ...(detail?.home_page ? [{ name: 'Home page', url: detail.home_page }] : []),
    ...(detail?.project_urls ?? []),
  ];
  if (links.length) {
    sections.push(
      '<h3>Links</h3>',
      `<p>${links
        .map((l) => `<a data-link="${escapeHtml(l.url)}">${escapeHtml(l.name)}</a>`)
        .join(' · ')}</p>`
    );
  }
  if (entry?.error) {
    sections.push(`<div class="note error">Could not load details: ${escapeHtml(entry.error)}</div>`);
  }
  return sections.join('');
}

function metaRow(key: string, value: string): string {
  return `<tr><td class="k">${key}</td><td>${value}</td></tr>`;
}

/**
 * The author's class docstring: escaped first (third-party text), then given
 * back the little markup a docstring carries — RST ``literals``. Line breaks
 * inside a paragraph survive via pre-wrap, because these texts hand-wrap their
 * own lists.
 */
function descriptionHtml(text: string): string {
  return docstringParagraphs(text)
    .map(
      (paragraph) =>
        `<p class="doc">${escapeHtml(paragraph).replace(/``([^`]+)``/g, '<span class="mono">$1</span>')}</p>`
    )
    .join('');
}

function renderDetail(): void {
  const row = model?.rows.find((r) => r.id === selected);
  if (!row) {
    detailEl.innerHTML = '<div class="empty">Select a plugin to see its details.</div>';
    return;
  }
  detailEl.innerHTML = detailHtml(row);
  const install = document.getElementById('install');
  install?.addEventListener('click', () => {
    actionErrors.delete(row.id);
    vscode.postMessage({ type: 'install', id: row.id });
  });
  document.getElementById('uninstall')?.addEventListener('click', () => {
    actionErrors.delete(row.id);
    vscode.postMessage({ type: 'uninstall', id: row.id });
  });
  document.getElementById('copy')?.addEventListener('click', () =>
    vscode.postMessage({ type: 'copyCommand', id: row.id })
  );
  detailEl.querySelectorAll<HTMLElement>('[data-link]').forEach((link) => {
    link.addEventListener('click', () =>
      vscode.postMessage({ type: 'openLink', url: link.dataset.link ?? '' })
    );
  });
}

function render(): void {
  renderStatus();
  renderList();
  renderDetail();
}

function select(id: string): void {
  selected = id;
  if (!details.has(id)) vscode.postMessage({ type: 'select', id });
  render();
}

listEl.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('.row');
  if (target?.dataset.row) select(target.dataset.row);
});

searchEl.addEventListener('input', () => {
  renderList();
});

document.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const key = chip.dataset.filter;
    if (!key) return;
    if (filters.has(key)) filters.delete(key);
    else filters.add(key);
    chip.classList.toggle('on', filters.has(key));
    renderList();
  });
});

el<HTMLButtonElement>('refresh').addEventListener('click', () => {
  details.clear();
  vscode.postMessage({ type: 'refresh' });
});

window.addEventListener('message', (event: MessageEvent<PluginsInMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'loading':
      loading = true;
      renderStatus();
      break;
    case 'model':
      loading = false;
      model = msg.model;
      // Keep the selection only while the row still exists.
      if (selected && !model.rows.some((r) => r.id === selected)) selected = undefined;
      render();
      break;
    case 'busy':
      busy = msg.id ?? undefined;
      renderDetail();
      break;
    case 'detail':
      details.set(msg.id, { detail: msg.detail, error: msg.error });
      if (msg.id === selected) renderDetail();
      break;
    case 'actionError':
      actionErrors.set(msg.id, msg.message);
      renderDetail();
      break;
  }
});

vscode.postMessage({ type: 'ready' });
