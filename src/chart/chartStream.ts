/**
 * The host-side snapshot of one chart's bridge event stream (start + all bars
 * + plot keys + metas + trades + stats + end), and the webview messages each
 * event becomes. A chart tab and a dashboard cell both keep one, so a webview
 * that (re)loads gets the whole chart replayed. vscode-free.
 */
import type {
  BarRow,
  BridgeEvent,
  ColorDeltaRow,
  DrawingEventRecord,
  FeedStatusEvent,
  PlotMetaRecord,
  RobustnessReport,
  StartEvent,
  TickEvent,
  TradeRecord,
} from '../run/bridgeClient';
import { upsertLastBar } from './barRows';
import { foldColorRows, liveTrimCount } from './liveWindow';
import type { ChartInMessage } from './messages';

export interface ChartSnapshot {
  start: StartEvent;
  bars: BarRow[];
  plotKeys: string[];
  /** Plot style metadata keyed by plot id — upserted, a repeated id is an
   * update (a plot turning dynamic re-emits its meta). */
  plotMeta: Map<string, PlotMetaRecord>;
  /** Accumulated per-bar dynamic color deltas (sparse, only-on-change). */
  colors: ColorDeltaRow[];
  /** Live drawing objects keyed by "family#vid": create/update upserts the
   * latest state, delete removes it — replay sends only what still exists. */
  drawings: Map<string, DrawingEventRecord>;
  trades: TradeRecord[];
  openTrades: TradeRecord[];
  stats: Record<string, number | null> | undefined;
  robustness: RobustnessReport | undefined;
  /** A live chart's history is complete (the bridge's `live` event). */
  live: boolean;
  /** Bar index of `bars[0]`: a live chart drops its oldest bars (see liveWindow). */
  barBase: number;
  /** The forming bar's latest update; dropped by the bar's close. */
  tick: TickEvent | undefined;
  feedStatus: FeedStatusEvent | undefined;
  ended: { bars: number; cancelled: boolean } | undefined;
}

export function emptySnapshot(start: StartEvent): ChartSnapshot {
  return {
    start,
    bars: [],
    plotKeys: [],
    plotMeta: new Map(),
    colors: [],
    drawings: new Map(),
    trades: [],
    openTrades: [],
    stats: undefined,
    robustness: undefined,
    live: false,
    barBase: 0,
    tick: undefined,
    feedStatus: undefined,
    ended: undefined,
  };
}

export class ChartStream {
  /** Undefined until the first `start` event (or preview). */
  snap: ChartSnapshot | undefined;

  /** Install a copy of another stream's snapshot (a chart tab mirroring a
   * dashboard chart): its bar base included, so a trimmed live chart's
   * bar-index drawings and trades stay on their bars. */
  load(snap: ChartSnapshot): void {
    this.snap = structuredClone(snap);
  }

  /** Install a bars-only preview of an `.ohlcv` file (no run). */
  preview(start: StartEvent, bars: BarRow[]): void {
    this.snap = { ...emptySnapshot(start), bars, ended: { bars: bars.length, cancelled: false } };
  }

  /**
   * Record a bridge event in the snapshot and return the webview messages it
   * becomes. A `start` resets the snapshot (a new run replaces the chart).
   */
  apply(event: BridgeEvent): ChartInMessage[] {
    switch (event.e) {
      case 'start':
        this.snap = emptySnapshot(event);
        return [{ type: 'reset', start: event }];
      case 'bars': {
        if (this.snap) {
          for (const row of event.d) upsertLastBar(this.snap.bars, row, (r) => r[0]);
          // A closed bar supersedes the ticks of its own bar (rows are in time order)
          const lastTs = event.d[event.d.length - 1]?.[0];
          if (this.snap.tick && lastTs !== undefined && lastTs >= this.snap.tick.d[0]) {
            this.snap.tick = undefined;
          }
        }
        const out: ChartInMessage[] = [{ type: 'bars', rows: event.d }];
        const base = this.trimLive();
        if (base !== undefined) out.push({ type: 'barBase', base });
        return out;
      }
      case 'live':
        if (this.snap) this.snap.live = true;
        return [{ type: 'live' }];
      case 'tick':
        if (this.snap) this.snap.tick = event;
        return [{ type: 'tick', tick: event }];
      case 'feedStatus':
        if (this.snap) this.snap.feedStatus = event;
        return [{ type: 'feedStatus', status: event }];
      case 'plotKeys':
        if (this.snap) this.snap.plotKeys = event.keys;
        return [{ type: 'plotKeys', keys: event.keys }];
      case 'plotMeta':
        if (this.snap) for (const meta of event.metas) this.snap.plotMeta.set(meta.id, meta);
        return [{ type: 'plotMeta', metas: event.metas }];
      case 'colors':
        if (this.snap) for (const row of event.d) this.snap.colors.push(row);
        return [{ type: 'colors', d: event.d }];
      case 'drawings':
        if (this.snap) {
          for (const rec of event.d) {
            const key = `${rec.obj}#${rec.id}`;
            if (rec.op === 'delete') this.snap.drawings.delete(key);
            else this.snap.drawings.set(key, rec);
          }
        }
        return [{ type: 'drawings', d: event.d }];
      case 'trades':
        if (this.snap) for (const t of event.d) this.snap.trades.push(t);
        return [{ type: 'trades', trades: event.d }];
      case 'openTrades':
        if (this.snap) this.snap.openTrades = event.d;
        return [{ type: 'openTrades', trades: event.d }];
      case 'stats':
        if (this.snap) this.snap.stats = event.d;
        return [{ type: 'stats', stats: event.d }];
      case 'robustness':
        if (!event.report) return [];
        if (this.snap) this.snap.robustness = event.report;
        return [{ type: 'robustness', report: event.report }];
      case 'end':
        if (this.snap) this.snap.ended = { bars: event.bars, cancelled: event.cancelled };
        return [{ type: 'end', bars: event.bars, cancelled: event.cancelled }];
      default:
        return [];
    }
  }

  /** Drop a live chart's oldest bars past its bar limit; the bar index its
   * first bar has now, or undefined when nothing was dropped. */
  private trimLive(): number | undefined {
    const s = this.snap;
    if (!s?.start.live) return undefined;
    const drop = liveTrimCount(s.bars.length);
    if (drop === 0) return undefined;
    s.bars.splice(0, drop);
    s.barBase += drop;
    s.colors = foldColorRows(s.colors, s.bars[0][0]);
    return s.barBase;
  }

  /** The messages that rebuild a webview from the snapshot (reset → meta →
   * keys → bar base → bars → colors → drawings → trades → stats → robustness →
   * live → feed status → tick → end; metas must precede the bars that
   * reference them, colors/drawings follow the bars their timestamps / bar
   * indices join against). */
  replay(): ChartInMessage[] {
    const s = this.snap;
    if (!s) return [];
    const out: ChartInMessage[] = [{ type: 'reset', start: s.start }];
    if (s.plotMeta.size) out.push({ type: 'plotMeta', metas: [...s.plotMeta.values()] });
    if (s.plotKeys.length) out.push({ type: 'plotKeys', keys: s.plotKeys });
    if (s.barBase) out.push({ type: 'barBase', base: s.barBase });
    if (s.bars.length) out.push({ type: 'bars', rows: s.bars });
    if (s.colors.length) out.push({ type: 'colors', d: s.colors });
    if (s.drawings.size) out.push({ type: 'drawings', d: [...s.drawings.values()] });
    if (s.trades.length) out.push({ type: 'trades', trades: s.trades });
    if (s.openTrades.length) out.push({ type: 'openTrades', trades: s.openTrades });
    if (s.stats) out.push({ type: 'stats', stats: s.stats });
    if (s.robustness) out.push({ type: 'robustness', report: s.robustness });
    if (s.live) out.push({ type: 'live' });
    if (s.feedStatus) out.push({ type: 'feedStatus', status: s.feedStatus });
    if (s.tick) out.push({ type: 'tick', tick: s.tick });
    if (s.ended) out.push({ type: 'end', bars: s.ended.bars, cancelled: s.ended.cancelled });
    return out;
  }
}
