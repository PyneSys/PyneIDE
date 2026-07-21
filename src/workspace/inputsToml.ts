/**
 * Minimal read/write of the `[inputs.<name>] value = ...` lines in a script's
 * sibling `.toml` (pynecore's script-settings format — see core/script.py
 * `Script.save`/`load`). No TOML library is bundled, so this touches only the
 * `value` lines and preserves everything else (metadata comments, the
 * `[script]` section, blank lines) byte for byte.
 */
import type { InputSpec, InputValue } from './inputsMessages';

/** Read the current `value = ...` of every `[inputs.<name>]` section. */
export function readInputValues(tomlText: string): Record<string, InputValue> {
  const values: Record<string, InputValue> = {};
  const lines = tomlText.split('\n');
  let current: string | undefined;
  for (const line of lines) {
    const header = /^\s*\[inputs\.([^\]]+)\]\s*$/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = undefined;
      continue;
    }
    if (current === undefined) continue;
    const m = /^\s*value\s*=\s*(.+?)\s*$/.exec(line);
    if (m) {
      const parsed = parseScalar(m[1]);
      if (parsed !== undefined) values[current] = parsed;
    }
  }
  return values;
}

/**
 * Rewrite the `value` line of each named input to the given value, preserving
 * the rest of the file. Sections missing from the file (or a missing file) are
 * appended in pynecore's format so a later run reads them back.
 */
export function writeInputValues(
  tomlText: string,
  values: Record<string, InputValue>,
  specs: readonly InputSpec[]
): string {
  const hasText = tomlText.trim().length > 0;
  const lines = (hasText ? tomlText : '# Indicator / Strategy / Library Settings\n\n[script]\n').split('\n');

  const remaining = new Set(Object.keys(values));

  // Section header line index -> input name.
  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*\[inputs\.([^\]]+)\]\s*$/.exec(lines[i]);
    if (!header) continue;
    const name = header[1];
    if (!(name in values)) continue;
    const end = sectionEnd(lines, i + 1);
    const valueLine = `value = ${formatScalar(values[name])}`;
    let replaced = false;
    for (let j = i + 1; j < end; j++) {
      if (/^\s*#?\s*value\s*=/.test(lines[j])) {
        lines[j] = valueLine;
        replaced = true;
        break;
      }
    }
    if (!replaced) lines.splice(end, 0, valueLine);
    remaining.delete(name);
  }

  // Append any input the file did not carry yet.
  if (remaining.size > 0) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('');
    for (const spec of specs) {
      if (!remaining.has(spec.name)) continue;
      lines.push(`[inputs.${spec.name}]`, `value = ${formatScalar(values[spec.name])}`, '');
    }
  }

  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

/** First line index at or after `from` that starts a new `[section]`. */
function sectionEnd(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) return i;
  }
  return lines.length;
}

function parseScalar(raw: string): InputValue | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\\\/g, '\\');
  }
  const n = Number(raw);
  if (Number.isFinite(n) && raw.trim() !== '') return n;
  return undefined;
}

function formatScalar(value: InputValue): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const escaped = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  return `"${escaped}"`;
}
