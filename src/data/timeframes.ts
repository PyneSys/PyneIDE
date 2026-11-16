/**
 * The timeframes the pickers offer (TradingView format), shared by the Symbol
 * Browser and a live chart's toolbar. Anything else goes through Custom.
 */
export const TIMEFRAMES = ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M'];

/** A TradingView timeframe the providers serve: minutes, or a multiplier with D/W/M
 * (`90`, `1D`, `D`). No provider has seconds bars, live or historical. */
const TIMEFRAME_RE = /^(?:\d+[DWM]?|[DWM])$/i;

/** The timeframe as typed, upper-cased and trimmed, or undefined when it is none. */
export function parseTimeframe(text: string): string | undefined {
  const tf = text.trim().toUpperCase();
  if (!TIMEFRAME_RE.test(tf) || /^0+[DWM]?$/.test(tf)) return undefined;
  return tf;
}
