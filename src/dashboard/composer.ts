/**
 * One dashboard chart is several event streams: the candles' (the base) and
 * one bridge process per script (a slot), since PyneCore runs one script per
 * process. The composer merges their event streams into the single
 * stream one chart webview draws, as if one script had plotted everything:
 *
 * - the base gives the start, the candles, the live state and the ticks' OHLC;
 * - every slot's plot keys, metas, color channels and plot titles get the
 *   slot's id as a prefix (`ema_fast: EMA`), and the plot key list only grows,
 *   so the rows already drawn keep their columns;
 * - a slot's drawing ids are made unique across slots, and its bar indexes
 *   (drawings, trades) are moved onto the base's when its history started on
 *   another bar;
 * - an overlay script's metas get `force_overlay`, as the merged start has
 *   one `overlay` flag for all;
 * - a strategy slot gives the equity columns, the trades and the stats.
 *
 * The history is held back until the base and every slot are live, then sent
 * in one go. Live, the base's closed bar is held until every running slot sent
 * the same bar, at most `SLOT_WAIT_MS` (the chart can replace only its last
 * bar, so a slot value of an earlier bar would be lost); the ticks of later
 * bars wait with it. A slot value of the last merged bar replaces it; one that
 * comes after a later bar went out is dropped. A slot value for a bar the base
 * has not closed yet waits for that bar. vscode-free.
 */
import type {
  BarRow,
  BridgeEvent,
  ColorDeltaRow,
  ColorEnc,
  DrawingEventRecord,
  EquityExcursions,
  PlotMetaRecord,
  StartEvent,
  TickEvent,
  TradeRecord,
} from '../run/bridgeClient';

/** Slot ids stay below this in a drawing id (`id * DRAWING_ID_STRIDE + slot`). */
const DRAWING_ID_STRIDE = 8;

/** How long a tick waits for the other processes' ticks of the same moment. */
export const TICK_COALESCE_MS = 50;

/** How long a live closed bar waits for the running slots' values of the same bar. */
export const SLOT_WAIT_MS = 5000;

export interface ComposerSlot {
  /** The script entry's id; the prefix of its plots. */
  id: string;
}

type SlotState = {
  id: string;
  index: number;
  start?: StartEvent;
  /** Loading: every event of the slot, in order, until the merged history goes out. */
  backlog: BridgeEvent[];
  live: boolean;
  /** Ended or failed: no more events are waited for. */
  done: boolean;
  /** The slot's own plot keys and where each one sits in the merged list. */
  keys: string[];
  keyMap: number[];
  /** Slot bar index + offset = base bar index. */
  offset: number;
  /** Plots (and the strategy's equity) by bar time, for bars not yet merged out. */
  rows: Map<number, BarRow>;
  /** Time of the latest closed bar the slot sent, -1 before the first. */
  rowTime: number;
  /** Colors and drawings that refer to a bar the base has not closed yet. */
  pendingColors: ColorDeltaRow[];
  pendingDrawings: DrawingEventRecord[];
  tick?: TickEvent;
};

export interface ComposerCallbacks {
  /** The merged stream. */
  emit: (event: BridgeEvent) => void;
  /** Schedules a callback (a timer in the IDE; synchronous in tests). */
  schedule?: (callback: () => void, ms: number) => void;
}

export class ChartComposer {
  private readonly slots: SlotState[];
  private readonly emit: (event: BridgeEvent) => void;
  private readonly schedule: (callback: () => void, ms: number) => void;
  private baseStart?: StartEvent;
  private readonly baseBacklog: BridgeEvent[] = [];
  private baseLive = false;
  private baseDone = false;
  /** The merged history went out: the stream is live. */
  private flushed = false;
  /** The merged plot keys; they only grow. */
  private readonly keys: string[] = [];
  /** Time and bar index of the last merged bar, -1 before the first. */
  private lastTime = -1;
  private lastIndex = -1;
  /** Time of the base's latest live close, -1 before the first. The history's
   * last bar can still be forming (the downloaded partial bar): its ticks go
   * out until this close ends them. */
  private closedTime = -1;
  /** Base bar times by bar index, while flushing (for the slot offsets). */
  private readonly baseTimes: number[] = [];
  private lastBaseRow?: BarRow;
  private baseTick?: TickEvent;
  private tickScheduled = false;
  /** Live: the base's closed bars waiting for the running slots' values, in time order. */
  private readonly held: BarRow[] = [];

  constructor(slots: ComposerSlot[], callbacks: ComposerCallbacks) {
    if (slots.length >= DRAWING_ID_STRIDE) {
      throw new Error(`a dashboard chart runs at most ${DRAWING_ID_STRIDE - 1} scripts`);
    }
    this.slots = slots.map((slot, index) => ({
      id: slot.id, index, backlog: [], live: false, done: false, keys: [], keyMap: [],
      offset: 0, rows: new Map(), rowTime: -1, pendingColors: [], pendingDrawings: [],
    }));
    this.emit = callbacks.emit;
    this.schedule = callbacks.schedule ?? ((callback) => callback());
  }

  /** Whether the merged history went out. */
  isLive(): boolean {
    return this.flushed;
  }

  /** An event of the base (data-only) process. */
  base(event: BridgeEvent): void {
    if (!this.flushed) {
      switch (event.e) {
        case 'start':
          this.baseStart = event;
          return;
        case 'live':
          this.baseLive = true;
          this.tryFlush();
          return;
        case 'end':
        case 'error':
          this.baseDone = true;
          this.baseBacklog.push(event);
          this.tryFlush();
          return;
        case 'bars':
          // A live close while a slot is still loading ends its bar's ticks too
          if (this.baseLive) for (const row of event.d) this.closedTime = Math.max(this.closedTime, row[0]);
          this.baseBacklog.push(event);
          return;
        default:
          this.baseBacklog.push(event);
          return;
      }
    }
    switch (event.e) {
      case 'bars':
        this.holdRows(event.d);
        return;
      case 'tick':
        this.baseTick = event;
        this.scheduleTick();
        return;
      case 'end':
        this.releaseHeld(Infinity);
        this.emit(event);
        return;
      case 'feedStatus':
        this.emit(event);
        return;
      default:
        return;
    }
  }

  /** An event of a script process. */
  slot(id: string, event: BridgeEvent): void {
    const slot = this.slots.find((s) => s.id === id);
    if (!slot || slot.done) return;
    if (event.e === 'start') {
      slot.start = event;
      return;
    }
    if (!this.flushed) {
      if (event.e === 'live') slot.live = true;
      else if (event.e === 'end' || event.e === 'error') slot.done = true;
      else slot.backlog.push(event);
      this.tryFlush();
      return;
    }
    if (event.e === 'end' || event.e === 'error') {
      slot.done = true;
      this.releaseHeld();
      return;
    }
    this.slotEvent(slot, event);
  }

  /** Every process went live (or stopped): send the merged history. */
  private tryFlush(): void {
    if (this.flushed || !this.baseStart) return;
    if (!this.baseDone && !this.baseLive) return;
    if (this.slots.some((s) => !s.live && !s.done)) return;
    this.flushed = true;

    this.emit(this.mergedStart(this.baseStart));
    // The slots' offsets come from the base's bar times
    for (const ev of this.baseBacklog) {
      if (ev.e !== 'bars') continue;
      for (const row of ev.d) {
        // A row of the last row's time replaces it: the same bar
        if (row[0] !== this.baseTimes[this.baseTimes.length - 1]) this.baseTimes.push(row[0]);
      }
    }
    const baseIndex = new Map(this.baseTimes.map((t, i) => [t, i]));
    for (const slot of this.slots) slot.offset = slotOffset(slot.backlog, baseIndex);
    // Keys and metas first, then the slots' rows wait for the base's bars
    for (const slot of this.slots) {
      for (const ev of slot.backlog) {
        if (ev.e === 'plotKeys' || ev.e === 'plotMeta' || ev.e === 'bars') this.slotEvent(slot, ev);
      }
    }
    let ended: BridgeEvent | undefined;
    for (const ev of this.baseBacklog) {
      if (ev.e === 'bars') this.emitRows(ev.d);
      else if (ev.e === 'end' || ev.e === 'error') ended = ev;
      else if (ev.e === 'feedStatus') continue;
      else if (ev.e === 'tick') this.baseTick = ev;
    }
    for (const slot of this.slots) {
      for (const ev of slot.backlog) {
        if (ev.e !== 'plotKeys' && ev.e !== 'plotMeta' && ev.e !== 'bars') this.slotEvent(slot, ev);
      }
      slot.backlog = [];
    }
    this.baseTimes.length = 0;
    if (this.baseLive) this.emit({ e: 'live' });
    const status = [...this.baseBacklog].reverse().find((ev) => ev.e === 'feedStatus');
    if (status) this.emit(status);
    this.baseBacklog.length = 0;
    if (ended?.e === 'end') this.emit(ended);
    else if (this.baseTick) this.scheduleTick();
  }

  private mergedStart(base: StartEvent): StartEvent {
    const scripts = this.slots.filter((s) => s.start);
    const strategy = scripts.find((s) => s.start?.scriptType === 'strategy')?.start;
    return {
      ...base,
      script: '',
      scriptTitle: scripts.map((s) => s.id).join(', '),
      scriptShortTitle: scripts.map((s) => s.id).join(', '),
      scriptType: strategy ? 'strategy' : 'indicator',
      overlay: false,
      initialCapital: strategy?.initialCapital,
      dataOnly: scripts.length === 0 ? true : undefined,
      live: base.live && { ...base.live, historyTrades: strategy?.live?.historyTrades ?? false },
      outputs: { plot: '', strat: null, trades: null, viz: null, profile: null, robustness: null },
    };
  }

  private slotEvent(slot: SlotState, event: BridgeEvent): void {
    switch (event.e) {
      case 'plotKeys':
        this.slotKeys(slot, event.keys);
        return;
      case 'plotMeta':
        this.emit({ e: 'plotMeta', metas: event.metas.map((m) => this.meta(slot, m)) });
        return;
      case 'bars':
        for (const row of event.d) this.slotRow(slot, row);
        return;
      case 'colors': {
        const rows = event.d.map((row): ColorDeltaRow => [row[0], this.colors(slot, row[1])]);
        const ready = rows.filter((row) => row[0] <= this.lastTime);
        slot.pendingColors.push(...rows.filter((row) => row[0] > this.lastTime));
        if (ready.length) this.emit({ e: 'colors', d: ready });
        return;
      }
      case 'drawings': {
        const recs = event.d.map((rec) => this.drawing(slot, rec));
        const ready = recs.filter((rec) => rec.i <= this.lastIndex);
        slot.pendingDrawings.push(...recs.filter((rec) => rec.i > this.lastIndex));
        if (ready.length) this.emit({ e: 'drawings', d: ready });
        return;
      }
      case 'trades':
        this.emit({ e: 'trades', d: event.d.map((t) => this.trade(slot, t)) });
        return;
      case 'openTrades':
        this.emit({ e: 'openTrades', d: event.d.map((t) => this.trade(slot, t)) });
        return;
      case 'stats':
        if (slot.start?.scriptType === 'strategy') this.emit(event);
        return;
      case 'tick':
        slot.tick = event;
        this.scheduleTick();
        return;
      default:
        return;
    }
  }

  private slotKeys(slot: SlotState, keys: string[]): void {
    let grew = false;
    for (let i = slot.keys.length; i < keys.length; i++) {
      slot.keyMap.push(this.keys.length);
      this.keys.push(`${slot.id}: ${keys[i]}`);
      grew = true;
    }
    slot.keys = [...keys];
    if (grew) this.emit({ e: 'plotKeys', keys: [...this.keys] });
  }

  private prefixed(slot: SlotState, name: string | undefined): string | undefined {
    return name === undefined ? undefined : `${slot.id}: ${name}`;
  }

  private meta(slot: SlotState, meta: PlotMetaRecord): PlotMetaRecord {
    const out: PlotMetaRecord = { ...meta, id: `${slot.id}: ${meta.id}` };
    if (meta.title !== undefined) out.title = this.prefixed(slot, meta.title);
    for (const ref of ['plot1', 'plot2', 'hline1', 'hline2'] as const) {
      if (typeof meta[ref] === 'string') out[ref] = this.prefixed(slot, meta[ref]);
    }
    if (slot.start?.overlay) out.force_overlay = true;
    return out;
  }

  private colors(slot: SlotState, channels: Record<string, ColorEnc>): Record<string, ColorEnc> {
    const out: Record<string, ColorEnc> = {};
    for (const [channel, enc] of Object.entries(channels)) out[`${slot.id}: ${channel}`] = enc;
    return out;
  }

  private drawingId(slot: SlotState, id: number): number {
    return id * DRAWING_ID_STRIDE + slot.index;
  }

  private drawing(slot: SlotState, rec: DrawingEventRecord): DrawingEventRecord {
    const out: DrawingEventRecord = { ...rec, i: rec.i + slot.offset, id: this.drawingId(slot, rec.id) };
    if (rec.s) out.s = this.drawingState(slot, rec.s);
    return out;
  }

  /** A drawing's state with its id unique across slots and its bar-index x
   * coordinates on the base's bar indexes. */
  private drawingState(slot: SlotState, s: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...s };
    if (typeof s.id === 'number') out.id = this.drawingId(slot, s.id);
    for (const nested of ['line1_state', 'line2_state']) {
      const line = s[nested];
      if (line && typeof line === 'object') {
        out[nested] = this.drawingState(slot, line as Record<string, unknown>);
      }
    }
    if (slot.offset === 0 || s.xloc === 'bar_time') return out;
    for (const field of ['x', 'x1', 'x2', 'left', 'right']) {
      if (typeof s[field] === 'number') out[field] = (s[field] as number) + slot.offset;
    }
    if (Array.isArray(s.points)) {
      out.points = s.points.map((pt: unknown) => {
        if (!pt || typeof pt !== 'object') return pt;
        const p = pt as Record<string, unknown>;
        return typeof p.index === 'number' ? { ...p, index: p.index + slot.offset } : p;
      });
    }
    return out;
  }

  private trade(slot: SlotState, t: TradeRecord): TradeRecord {
    if (slot.offset === 0) return t;
    return {
      ...t,
      entryBar: t.entryBar + slot.offset,
      exitBar: t.exitBar >= 0 ? t.exitBar + slot.offset : t.exitBar,
    };
  }

  /** A slot's closed bar: merged out now when the base already closed it. */
  private slotRow(slot: SlotState, row: BarRow): void {
    if (row[0] < this.lastTime) return;
    slot.rows.set(row[0], row);
    slot.rowTime = Math.max(slot.rowTime, row[0]);
    if (row[0] === this.lastTime && this.lastBaseRow) this.emit({ e: 'bars', d: [this.merge(this.lastBaseRow)] });
    if (this.held.length) this.releaseHeld();
  }

  /**
   * The base's live closed bars: held until every running slot sent its value
   * of the same bar (or a later one), at most `SLOT_WAIT_MS` each. A row of the
   * last merged bar replaces it at once.
   */
  private holdRows(rows: BarRow[]): void {
    const added: number[] = [];
    for (const row of rows) {
      this.closedTime = Math.max(this.closedTime, row[0]);
      const last = this.held[this.held.length - 1];
      if (last && row[0] < last[0]) continue;
      if (last && row[0] === last[0]) {
        this.held[this.held.length - 1] = row;
      } else if (row[0] <= this.lastTime) {
        this.emitRows([row]);
      } else {
        this.held.push(row);
        added.push(row[0]);
      }
    }
    this.releaseHeld();
    for (const time of added) {
      if (this.held.some((r) => r[0] === time)) this.schedule(() => this.releaseHeld(time), SLOT_WAIT_MS);
    }
  }

  /**
   * Merges out the held rows every running slot has sent, and the ones up to
   * `expired` (their wait is over) with whatever the slots sent; then the
   * forming bar's tick that waited for them.
   */
  private releaseHeld(expired = -1): void {
    let count = 0;
    while (count < this.held.length) {
      const time = this.held[count][0];
      if (time > expired && this.slots.some((s) => !s.done && s.rowTime < time)) break;
      count++;
    }
    if (!count) return;
    this.emitRows(this.held.splice(0, count));
    if (!this.held.length && this.baseTick) this.scheduleTick();
  }

  /** The base's closed bars, merged with the slots' values of the same bars. */
  private emitRows(rows: BarRow[]): void {
    if (!rows.length) return;
    const merged: BarRow[] = [];
    for (const row of rows) {
      if (row[0] < this.lastTime) continue;
      if (row[0] > this.lastTime) this.lastIndex++;
      this.lastTime = row[0];
      this.lastBaseRow = row;
      merged.push(this.merge(row));
      for (const slot of this.slots) {
        for (const t of slot.rows.keys()) if (t < row[0]) slot.rows.delete(t);
      }
    }
    if (!merged.length) return;
    this.emit({ e: 'bars', d: merged });
    if (this.baseTick && this.baseTick.d[0] <= this.closedTime) this.baseTick = undefined;
    this.releasePending();
  }

  private releasePending(): void {
    const colors: ColorDeltaRow[] = [];
    const drawings: DrawingEventRecord[] = [];
    for (const slot of this.slots) {
      if (slot.pendingColors.length) {
        colors.push(...slot.pendingColors.filter((row) => row[0] <= this.lastTime));
        slot.pendingColors = slot.pendingColors.filter((row) => row[0] > this.lastTime);
      }
      if (slot.pendingDrawings.length) {
        drawings.push(...slot.pendingDrawings.filter((rec) => rec.i <= this.lastIndex));
        slot.pendingDrawings = slot.pendingDrawings.filter((rec) => rec.i > this.lastIndex);
      }
    }
    if (colors.length) this.emit({ e: 'colors', d: colors.sort((a, b) => a[0] - b[0]) });
    if (drawings.length) this.emit({ e: 'drawings', d: drawings });
  }

  /** A base row (candle) with every slot's plots of the same bar. */
  private merge(base: BarRow, source: (slot: SlotState) => BarRow | undefined = (slot) => slot.rows.get(base[0])): BarRow {
    const plots: (number | null)[] = new Array(this.keys.length).fill(null);
    let equity: number | null | undefined;
    let excursions: EquityExcursions | null | undefined;
    for (const slot of this.slots) {
      const row = source(slot);
      if (!row) continue;
      const values = row[6] ?? [];
      for (let i = 0; i < slot.keyMap.length && i < values.length; i++) plots[slot.keyMap[i]] = values[i];
      if (slot.start?.scriptType === 'strategy') {
        equity = row[7];
        excursions = row[8];
      }
    }
    const out: BarRow = [base[0], base[1], base[2], base[3], base[4], base[5], plots];
    if (equity !== undefined) out.push(equity, excursions ?? null);
    return out;
  }

  private scheduleTick(): void {
    if (this.tickScheduled || !this.flushed) return;
    this.tickScheduled = true;
    this.schedule(() => {
      this.tickScheduled = false;
      this.emitTick();
    }, TICK_COALESCE_MS);
  }

  /** The forming bar: the base's candle with the slots' ticks of the same bar. */
  private emitTick(): void {
    const base = this.baseTick;
    if (!base || base.d[0] < this.lastTime || base.d[0] <= this.closedTime || this.held.length) return;
    const time = base.d[0];
    const current = (slot: SlotState): TickEvent | undefined =>
      slot.tick && slot.tick.d[0] === time ? slot.tick : undefined;
    const tick: TickEvent = {
      e: 'tick',
      ran: this.slots.some((slot) => current(slot)?.ran),
      d: this.merge(base.d, (slot) => current(slot)?.d),
    };
    const colors: Record<string, ColorEnc> = {};
    const drawings: DrawingEventRecord[] = [];
    for (const slot of this.slots) {
      const t = current(slot);
      if (!t?.ran) continue;
      if (t.colors) Object.assign(colors, this.colors(slot, t.colors));
      if (t.drawings) drawings.push(...t.drawings.map((rec) => this.drawing(slot, rec)));
      if (slot.start?.scriptType === 'strategy') {
        if (t.trades) tick.trades = t.trades.map((tr) => this.trade(slot, tr));
        if (t.openTrades) tick.openTrades = t.openTrades.map((tr) => this.trade(slot, tr));
      }
    }
    if (tick.ran) {
      tick.colors = colors;
      tick.drawings = drawings;
    }
    this.emit(tick);
  }
}

/**
 * Base bar index minus slot bar index, from the first bar both streamed: zero
 * when the slot's history started on the base's first bar.
 */
function slotOffset(backlog: BridgeEvent[], baseIndex: Map<number, number>): number {
  let index = -1;
  let lastTime: number | undefined;
  for (const ev of backlog) {
    if (ev.e !== 'bars') continue;
    for (const row of ev.d) {
      // A row of the last row's time replaces it: the same bar
      if (row[0] !== lastTime) index++;
      lastTime = row[0];
      const at = baseIndex.get(row[0]);
      if (at !== undefined) return at - index;
    }
  }
  return 0;
}
