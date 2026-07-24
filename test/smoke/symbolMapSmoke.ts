/**
 * Symbol Map smoke test — verifies the pure, VSCode-free logic behind the Symbol
 * Map panel: the line-oriented `symbol_map.toml` read/write/remove round-trip and
 * the {@link buildSymbolMapModel} ok/missing derivation and data-file surfacing.
 *
 * Usage: node dist/symbol-map-smoke.js
 * Needs no VSCode runtime and no Python — it drives a throwaway workdir of
 * synthetic `data/*.ohlcv` + sibling `.toml` pairs and a `config/symbol_map.toml`.
 *
 * Assertions:
 *   (a) writeSymbolMapEntry -> readSymbolMapEntries round-trips key+value and
 *       preserves the file's header/comments;
 *   (b) removeSymbolMapEntry deletes only the target entry, leaving others and
 *       comments intact;
 *   (c) buildSymbolMapModel reports the timeframe-independent instrument's
 *       downloaded timeframes (availableTfs, merged + sorted) for a mapping, and
 *       an empty list for a mapping with no data;
 *   (d) instruments collapse the per-file data into one target per provider+native
 *       symbol, carrying the merged timeframes and a human symbol label;
 *   (e) a KEY with a trailing `:TF` parses into tvSymbol+tf while a genuine symbol
 *       colon is NOT mis-split.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildSymbolMapModel } from '../../src/data/symbolMapModel';
import {
  readSymbolMapEntries,
  removeSymbolMapEntry,
  symbolMapPath,
  writeSymbolMapEntry,
} from '../../src/run/symbolMapFile';

let failed = false;

/** Print a PASS/FAIL line; remember any failure so the process can exit non-zero. */
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failed = true;
    console.log(`  ✗ ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

/** Create a fresh throwaway workdir with `config/` and `data/` present. */
function makeWorkdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-symmap-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return dir;
}

/** Write a synthetic `.ohlcv` (content is irrelevant — only its name is read) and
 * a sibling syminfo `.toml` carrying the `[symbol]` fields and a `[download]`
 * provider string, so readDataFiles derives symbol/period/native from it. */
function writeDataPair(
  workdir: string,
  stem: string,
  prefix: string,
  ticker: string,
  period: string,
  provider: string
): void {
  const dataDir = path.join(workdir, 'data');
  fs.writeFileSync(path.join(dataDir, `${stem}.ohlcv`), Buffer.alloc(24));
  const toml = [
    '[symbol]',
    `prefix = "${prefix}"`,
    `ticker = "${ticker}"`,
    `period = "${period}"`,
    'type = "crypto"',
    '',
    '[download]',
    `provider = "${provider}"`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dataDir, `${stem}.toml`), toml);
}

function main(): void {
  // ---- (a) round-trip + header/comment preservation ----
  const wA = makeWorkdir();
  const preamble =
    '# custom user header comment\n' +
    '[symbol_map]\n' +
    '"AAA:BBB" = "ccxt:AAA:BBB"\n' +
    '# a trailing comment\n';
  fs.writeFileSync(symbolMapPath(wA), preamble);

  writeSymbolMapEntry(wA, 'CCC:DDD', 'ccxt:CCC:DDD');
  const entriesA = readSymbolMapEntries(wA);
  const byKeyA = new Map(entriesA.map((e) => [e.key, e.value]));
  check(
    '(a) round-trips existing + new key=value',
    byKeyA.get('AAA:BBB') === 'ccxt:AAA:BBB' && byKeyA.get('CCC:DDD') === 'ccxt:CCC:DDD',
    JSON.stringify(entriesA)
  );
  const rawA = fs.readFileSync(symbolMapPath(wA), 'utf8');
  check(
    '(a) preserves header + trailing comment',
    rawA.includes('# custom user header comment') && rawA.includes('# a trailing comment'),
    rawA
  );

  // Updating an existing key rewrites in place, not a duplicate.
  writeSymbolMapEntry(wA, 'AAA:BBB', 'ccxt:AAA:CHANGED');
  const updated = readSymbolMapEntries(wA).filter((e) => e.key === 'AAA:BBB');
  check(
    '(a) update rewrites in place (no duplicate)',
    updated.length === 1 && updated[0].value === 'ccxt:AAA:CHANGED',
    JSON.stringify(updated)
  );

  // ---- (b) remove only the target, comments + others intact ----
  removeSymbolMapEntry(wA, 'AAA:BBB');
  const afterRemove = readSymbolMapEntries(wA);
  check(
    '(b) removes only the target entry',
    afterRemove.length === 1 && afterRemove[0].key === 'CCC:DDD',
    JSON.stringify(afterRemove)
  );
  const rawB = fs.readFileSync(symbolMapPath(wA), 'utf8');
  check(
    '(b) leaves comments + other entries intact',
    rawB.includes('# custom user header comment') &&
      rawB.includes('# a trailing comment') &&
      rawB.includes('"CCC:DDD" = "ccxt:CCC:DDD"') &&
      !rawB.includes('AAA:BBB'),
    rawB
  );

  // ---- (c/d/e) model derivation over a populated workdir ----
  const wB = makeWorkdir();
  // Two timeframes of one instrument (multi-colon native), to prove they collapse
  // into a single target whose timeframes merge + sort coarsest-last.
  writeDataPair(wB, 'ccxt_BYBIT_BTCUSDT_1D', 'BYBIT', 'BTCUSDT.P', '1D', 'ccxt:BYBIT:BTC/USDT:USDT@1D');
  writeDataPair(wB, 'ccxt_BYBIT_BTCUSDT_60', 'BYBIT', 'BTCUSDT.P', '60', 'ccxt:BYBIT:BTC/USDT:USDT@60');
  writeDataPair(wB, 'capitalcom_MSFT_60', 'NASDAQ', 'MSFT', '60', 'capitalcom:MSFT@60');

  const mapBody =
    '# workdir symbol map\n' +
    '[symbol_map]\n' +
    '"BYBIT:BTCUSDT.P" = "ccxt:BYBIT:BTC/USDT:USDT"\n' +
    '"NASDAQ:MSFT:60" = "capitalcom:MSFT"\n' +
    '"NASDAQ:AAPL" = "capitalcom:AAPL"\n';
  fs.writeFileSync(symbolMapPath(wB), mapBody);

  const model = buildSymbolMapModel(wB);
  const bybit = model.entries.find((e) => e.key === 'BYBIT:BTCUSDT.P');
  const msft = model.entries.find((e) => e.key === 'NASDAQ:MSFT:60');
  const aapl = model.entries.find((e) => e.key === 'NASDAQ:AAPL');

  const eq = (a: string[] | undefined, b: string[]): boolean =>
    !!a && a.length === b.length && a.every((v, i) => v === b[i]);

  check(
    '(c) timeframe-independent mapping reports merged + sorted downloaded TFs',
    !!bybit && eq(bybit.availableTfs, ['60', '1D']),
    JSON.stringify(bybit)
  );
  check(
    '(c) mapping with one downloaded TF reports it',
    !!msft && eq(msft.availableTfs, ['60']),
    JSON.stringify(msft)
  );
  check(
    '(c) mapping with no data -> empty availableTfs',
    !!aapl && aapl.availableTfs.length === 0,
    JSON.stringify(aapl)
  );

  const instByNative = new Map(model.instruments.map((i) => [i.native, i]));
  const iBybit = instByNative.get('ccxt:BYBIT:BTC/USDT:USDT');
  const iMsft = instByNative.get('capitalcom:MSFT');
  check(
    '(d) instruments collapse per-file data into one target per native symbol',
    model.instruments.length === 2 &&
      !!iBybit && iBybit.symbol === 'BYBIT:BTCUSDT.P' && eq(iBybit.timeframes, ['60', '1D']) &&
      !!iMsft && iMsft.symbol === 'NASDAQ:MSFT' && eq(iMsft.timeframes, ['60']),
    JSON.stringify(model.instruments)
  );
  check(
    '(d) instruments carry the provider token',
    !!iBybit && iBybit.provider === 'ccxt' && !!iMsft && iMsft.provider === 'capitalcom',
    JSON.stringify(model.instruments.map((i) => i.provider))
  );

  check(
    '(e) genuine symbol colon is NOT mis-split into a TF',
    !!bybit && bybit.tvSymbol === 'BYBIT:BTCUSDT.P' && bybit.tf === undefined,
    JSON.stringify(bybit)
  );
  check(
    '(e) trailing :TF parses into tvSymbol + tf',
    !!msft && msft.tvSymbol === 'NASDAQ:MSFT' && msft.tf === '60',
    JSON.stringify(msft)
  );

  fs.rmSync(wA, { recursive: true, force: true });
  fs.rmSync(wB, { recursive: true, force: true });

  if (failed) {
    console.log('SYMBOL MAP SMOKE FAILED');
    process.exit(1);
  }
  console.log('SYMBOL MAP SMOKE OK');
}

main();
