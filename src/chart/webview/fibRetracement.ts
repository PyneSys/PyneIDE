/**
 * Fibonacci retracement with the user's own levels: KLineChart's built-in
 * `fibonacciLine` draws a fixed set of levels in one color. The levels come
 * from the overlay's `extendData` (`FibExtend`); each one is drawn in its own
 * color, with the overlay's line width and dash. Level 1 is at the first
 * point, level 0 at the second, as in the built-in.
 */
import type { OverlayFigure, OverlayTemplate } from 'klinecharts';

import type { FibLevel } from '../drawingRecord';

export const FIB_OVERLAY = 'fibRetracement';

export interface FibExtend {
  levels: FibLevel[];
}

const LABEL_STYLES = {
  backgroundColor: 'rgba(0, 0, 0, 0)',
  borderColor: 'rgba(0, 0, 0, 0)',
  borderSize: 0,
  paddingLeft: 2,
  paddingRight: 2,
  paddingTop: 2,
  paddingBottom: 2,
};

export const fibRetracement: OverlayTemplate<FibExtend> = {
  name: FIB_OVERLAY,
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ chart, coordinates, bounding, overlay }) => {
    const [first, second] = overlay.points;
    if (coordinates.length < 2 || typeof first?.value !== 'number' || typeof second?.value !== 'number') {
      return [];
    }
    const precision = chart.getSymbol()?.pricePrecision ?? 2;
    const yDif = coordinates[0].y - coordinates[1].y;
    const valueDif = first.value - second.value;
    const figures: OverlayFigure[] = [];
    for (const level of overlay.extendData?.levels ?? []) {
      if (!level.visible) continue;
      const y = coordinates[1].y + yDif * level.value;
      const price = second.value + valueDif * level.value;
      const text = chart.getDecimalFold().format(chart.getThousandsSeparator().format(price.toFixed(precision)));
      figures.push(
        {
          type: 'line',
          attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
          styles: { color: level.color },
        },
        {
          type: 'text',
          ignoreEvent: true,
          attrs: { x: 0, y, text: `${level.value} (${text})`, baseline: 'bottom' },
          styles: { ...LABEL_STYLES, color: level.color },
        },
      );
    }
    return figures;
  },
};
