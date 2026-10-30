import type { TradeRecord } from '../../run/bridgeClient';

let activeDialog: HTMLDialogElement | undefined;

export function closeTradeDetails(): void {
  activeDialog?.close();
}

function valueText(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumSignificantDigits: 21 }) : '—';
  }
  return String(value);
}

function timeText(timestamp: number): string {
  const date = new Date(timestamp);
  return timestamp > 0 && Number.isFinite(date.getTime())
    ? date.toISOString().replace('T', ' ').replace('Z', ' UTC')
    : '—';
}

export function showTradeDetails(trade: TradeRecord, index: number): void {
  closeTradeDetails();
  const dialog = document.createElement('dialog');
  dialog.id = 'trade-details';
  dialog.setAttribute('aria-labelledby', 'trade-details-title');
  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.id = 'trade-details-title';
  title.textContent = `Trade ${index + 1} · ${(trade.size ?? 0) > 0 ? 'Long' : (trade.size ?? 0) < 0 ? 'Short' : '—'}`;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close trade details');
  close.autofocus = true;
  close.addEventListener('click', () => dialog.close());
  header.append(title, close);
  dialog.append(header);

  const content = document.createElement('div');
  content.className = 'trade-details-content';
  function section(title: string, fields: Array<[string, string | number | null | undefined]>): void {
    const group = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = title;
    const list = document.createElement('dl');
    for (const [label, value] of fields) {
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = valueText(value);
      list.append(term, description);
    }
    group.append(heading, list);
    content.append(group);
  }
  section('Entry', [
    ['Order ID', trade.entryId],
    ['Comment', trade.entryComment],
    ...(trade.entrySignal !== undefined ? [['Signal (comment or order ID)', trade.entrySignal] as [string, string | null]] : []),
    ['Time', timeText(trade.entryTime)],
    ['Bar index', trade.entryBar],
    ['Price', trade.entryPrice],
  ]);
  section('Exit', [
    ['Order ID', trade.exitId],
    ['Comment', trade.exitComment],
    ...(trade.exitSignal !== undefined ? [['Signal (comment or order ID)', trade.exitSignal] as [string, string | null]] : []),
    ['Time', timeText(trade.exitTime)],
    ['Bar index', trade.exitBar],
    ['Price', trade.exitPrice],
  ]);
  section('Results', [
    ['Position size (signed)', trade.size],
    ['Commission', trade.commission],
    ['Profit', trade.profit],
    ['Profit %', trade.profitPct],
    ['Cumulative profit', trade.cumProfit],
    ['Cumulative profit %', trade.cumProfitPct],
    ['Run-up', trade.maxRunup],
    ['Run-up %', trade.maxRunupPct],
    ['Drawdown', trade.maxDrawdown],
    ['Drawdown %', trade.maxDrawdownPct],
  ]);
  dialog.append(content);
  const note = document.createElement('p');
  note.className = 'trade-details-note';
  note.textContent = '— = not provided';
  dialog.append(note);
  dialog.addEventListener('click', (event) => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') event.stopPropagation();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (activeDialog !== dialog) return;
    activeDialog = undefined;
    document.querySelector<HTMLButtonElement>(`[data-trade-details="${index}"]`)?.focus();
  });
  document.body.append(dialog);
  activeDialog = dialog;
  dialog.showModal();
}
