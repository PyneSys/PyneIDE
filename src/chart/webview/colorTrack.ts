/**
 * Reconstructs per-bar dynamic plot colors from the bridge's sparse
 * only-on-change `colors` deltas. Each channel keeps its change list in
 * bar-index space; `colorAt` answers "what color at bar i" as the last
 * change at or before i, so consumers carry values forward exactly like
 * the pynecore viz stream intends.
 */
import type { ColorDeltaRow, ColorEnc } from '../../run/bridgeClient';

interface Channel {
  /** Bar indices of changes, ascending (deltas arrive in bar order). */
  idx: number[];
  enc: ColorEnc[];
  /** Monotonic lookup cursor — calc iterates bar indices ascending, so
   * lookups are amortized O(1); a backwards jump rescans from the start. */
  cursor: number;
}

export class ColorTrack {
  private channels = new Map<string, Channel>();

  clear(): void {
    this.channels.clear();
  }

  /** Ingest delta rows, resolving each row's bar timestamp to a bar index.
   * The bridge guarantees a delta's bar was already delivered; rows whose
   * timestamp is unknown are dropped. */
  addRows(rows: ColorDeltaRow[], tsToIndex: ReadonlyMap<number, number>): void {
    for (const [tMs, delta] of rows) {
      const barIndex = tsToIndex.get(tMs);
      if (barIndex === undefined) continue;
      for (const key of Object.keys(delta)) this.add(key, barIndex, delta[key]);
    }
  }

  private add(channel: string, barIndex: number, enc: ColorEnc): void {
    let ch = this.channels.get(channel);
    if (!ch) {
      ch = { idx: [], enc: [], cursor: 0 };
      this.channels.set(channel, ch);
    }
    const last = ch.idx.length - 1;
    if (last >= 0 && ch.idx[last] === barIndex) {
      ch.enc[last] = enc;
      return;
    }
    if (last >= 0 && ch.idx[last] > barIndex) return;
    ch.idx.push(barIndex);
    ch.enc.push(enc);
  }

  /** Last change at or before barIndex; undefined before the first change
   * (callers fall back to the meta's static color). */
  colorAt(channel: string, barIndex: number): ColorEnc | undefined {
    const ch = this.channels.get(channel);
    if (!ch || ch.idx.length === 0 || ch.idx[0] > barIndex) return undefined;
    let c = Math.min(ch.cursor, ch.idx.length - 1);
    if (ch.idx[c] > barIndex) c = 0;
    while (c + 1 < ch.idx.length && ch.idx[c + 1] <= barIndex) c++;
    ch.cursor = c;
    return ch.enc[c];
  }
}
