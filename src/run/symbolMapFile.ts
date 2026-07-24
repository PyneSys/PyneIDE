/**
 * Line-level writer for the global workdir symbol map,
 * `workdir/config/symbol_map.toml` (`[symbol_map]` table). Mirrors pynecore's
 * `pyne data map` command: it creates the file (with a documented header) and
 * the config dir when absent, and otherwise updates an existing key in place or
 * appends a new one under the table — preserving every existing comment and
 * entry. VSCode ships no TOML writer, and `tomli_w` is not a dependency, so this
 * stays a deliberately tiny scraper: enough for one flat `"KEY" = "value"` table.
 *
 * The value is a provider-qualified NATIVE symbol (`"ccxt:BYBIT:BTC/USDT:USDT"`),
 * same format as the sibling `.toml` `[download]` provider string minus its
 * `@TF` suffix. The optional `:TF` on the KEY overrides per timeframe.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SYMBOL_MAP_FILENAME = 'symbol_map.toml';

const HEADER = `# TradingView-style script symbols -> provider-qualified native symbols.
# Value format matches the [download] provider string: "provider:BROKER:SYMBOL".
# An optional ":TF" suffix on the KEY overrides per-timeframe.
# Used by both backtest (the .ohlcv path is derived) and live (PluginSymbol).
[symbol_map]
`;

/** Path to the global symbol map inside a workdir. */
export function symbolMapPath(workdir: string): string {
  return path.join(workdir, 'config', SYMBOL_MAP_FILENAME);
}

/**
 * Ensure `workdir/config/symbol_map.toml` exists (creating the config dir and a
 * documented `[symbol_map]` header when absent), and return its path — so the
 * "Edit symbol map" command always has a file to open.
 */
export function ensureSymbolMapFile(workdir: string): string {
  const filePath = symbolMapPath(workdir);
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, HEADER, 'utf8');
  }
  return filePath;
}

/** Escape a bare TOML basic-string body (keys and values are simple here). */
function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Insert or update `"key" = "value"` in the `[symbol_map]` table of
 * `workdir/config/symbol_map.toml`, creating the file + config dir with a
 * documented header when missing. Existing comments and entries are preserved;
 * a matching key is rewritten in place, otherwise the entry is appended to the
 * table.
 */
export function writeSymbolMapEntry(workdir: string, key: string, value: string): void {
  const filePath = symbolMapPath(workdir);
  const line = `"${tomlEscape(key)}" = "${tomlEscape(value)}"`;

  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${HEADER}${line}\n`, 'utf8');
    return;
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  // Match the key regardless of quoting style / surrounding whitespace.
  const keyRe = new RegExp(`^\\s*(?:"${escapeRe(key)}"|'${escapeRe(key)}'|${escapeRe(key)})\\s*=`);

  let tableStart = -1;
  let tableEnd = lines.length; // exclusive: first line of the NEXT table
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (tableStart < 0) {
      if (trimmed === '[symbol_map]') tableStart = i;
      continue;
    }
    // Another table header closes the [symbol_map] section.
    if (/^\[.*\]\s*$/.test(trimmed) && trimmed !== '[symbol_map]') {
      tableEnd = i;
      break;
    }
  }

  // Update in place if the key already exists (only within the table's span).
  const searchFrom = tableStart < 0 ? 0 : tableStart + 1;
  const searchTo = tableStart < 0 ? lines.length : tableEnd;
  for (let i = searchFrom; i < searchTo; i++) {
    if (keyRe.test(lines[i])) {
      lines[i] = line;
      fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
      return;
    }
  }

  if (tableStart < 0) {
    // No [symbol_map] table yet: append one (with a header if the file is bare).
    const needsNl = text.length > 0 && !text.endsWith('\n');
    fs.writeFileSync(filePath, `${text}${needsNl ? '\n' : ''}\n[symbol_map]\n${line}\n`, 'utf8');
    return;
  }

  // Append inside the existing table: after its last non-blank content line.
  let insertAt = tableStart + 1;
  for (let i = tableStart + 1; i < tableEnd; i++) {
    if (lines[i].trim() !== '') insertAt = i + 1;
  }
  lines.splice(insertAt, 0, line);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
