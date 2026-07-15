/**
 * Undo PyneComp's identifier renames for display (vscode-free).
 *
 * The compiler renames a user identifier only by APPENDING a suffix, and the
 * suffix shapes are part of pynecomp's stable ABI (see pynecomp `renames.py`):
 *
 *  - `__global__` / `__<8 hex>__` — block-scope suffix for variables colliding
 *    with a function/import/module name (every variable in `--strict` mode);
 *    extra trailing underscores dodge same-named source identifiers.
 *  - `__ren__` (class-body variant `__ren___`) — the canonical cross-unit
 *    rename of exported functions, UDT fields, enum members and keyword names.
 *
 * The original Pine name is therefore recoverable from the emitted name alone,
 * without a compiler-emitted name table. The (theoretical) ambiguity — a user
 * variable literally named `foo__global__` — is resolved conservatively by the
 * caller: a demangled display name is only used when it collides with nothing
 * else in the same listing.
 */

const SCOPE_SUFFIX = /^(.+?)__(?:global|[0-9a-f]{8})__+$/;
const REN_SUFFIX = /^(.+?)__ren___?$/;

/** The Pine name behind a compiler-renamed identifier, or undefined when the
 * name carries no known rename suffix. */
export function demangleName(name: string): string | undefined {
  const match = SCOPE_SUFFIX.exec(name) ?? REN_SUFFIX.exec(name);
  return match?.[1];
}

/**
 * Rewrite compiler-renamed `name`s in a DAP variables list to their Pine
 * originals, in place. A variable keeps its mangled name when the demangled
 * name would collide with anything else in the list (another variable's real
 * name, or a second rename demangling to the same base — two same-named Pine
 * variables from different block scopes stay tell-apart-able). `evaluateName`
 * keeps addressing the real runtime name so watch/copy still resolve.
 */
export function demangleVariables(variables: Record<string, unknown>[]): void {
  const names = new Set<string>();
  for (const v of variables) {
    if (typeof v.name === 'string') names.add(v.name);
  }
  const byBase = new Map<string, Record<string, unknown>[]>();
  for (const v of variables) {
    if (typeof v.name !== 'string') continue;
    const base = demangleName(v.name);
    if (!base || names.has(base)) continue;
    let list = byBase.get(base);
    if (!list) byBase.set(base, (list = []));
    list.push(v);
  }
  for (const [base, list] of byBase) {
    if (list.length !== 1) continue; // two renames share the base: keep both mangled
    const v = list[0];
    if (v.evaluateName === undefined) v.evaluateName = v.name;
    v.name = base;
  }
}
