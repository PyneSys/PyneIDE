/**
 * Pine-number rules for pyright's assignability reports in `@pyne` documents.
 *
 * A Pine int is a double at runtime, and Pine types `int / int` as an int while
 * Python types it as a float. Pyne code therefore hands float-typed expressions
 * to int slots by design: every int-consuming slot of the runtime truncates the
 * value it receives (a lib parameter, a `range()` argument), and a declaration
 * takes its Pine type from its annotation. pyright only knows Python's algebra,
 * so it reports each of those as an error.
 *
 * Such a report is recognised from its reason chain alone: every leaf reason
 * must be a `float` that is not assignable to `int` (or to the `None` / `na`
 * alternative of an optional int slot), and nothing else may have failed. A
 * container mismatch (`list[float]` into `list[int]`), a non-number source, or
 * a subscript index keeps its report: whether a subscript index is truncated
 * depends on its Pine type, which the float of Python's algebra cannot tell.
 *
 * Kept free of the `vscode` module so the smoke test can drive it directly
 * against real pyright output.
 */

/** The rules that report a value not fitting the declared type of its slot. */
const ASSIGNABILITY_RULES = new Set([
  'reportArgumentType',
  'reportAssignmentType',
  'reportAttributeAccessIssue',
  'reportReturnType',
]);

/** A leaf reason: one concrete source type failing one concrete target type. */
const LEAF = /^"([^"]+)" is not assignable to "([^"]+)"$/;

/** Intermediate reasons that only restate the failing pair one level up. */
const RESTATEMENTS = [
  /^Type "[^"]+" is not assignable to type "[^"]+"$/,
  /^Expression of type "[^"]+" cannot be assigned to attribute "[^"]+" of class "[^"]+"$/,
];

/** The optional alternative of an optional int slot: `int | None`, `int | NA[int]`. */
const OPTIONAL_TARGET = /^(None|NA\[[^\]]*\])$/;

/** A `range()` argument: pyright types `range` through its `__new__`. */
const RANGE_ARGUMENT =
  /^Argument of type "float" cannot be assigned to parameter "(start|stop|step)" of type "SupportsIndex" in function "__new__"$/;

/** The reasons pyright gives for a float `range()` argument. */
const RANGE_REASONS = new Set([
  '"float" is incompatible with protocol "SupportsIndex"',
  '"__index__" is not present',
]);

/**
 * Whether a pyright report is a Pine int slot receiving a float-typed number,
 * which Pyne accepts.
 *
 * @param rule The pyright rule of the report, if it has one.
 * @param message The full report message, reason chain included.
 */
export function isPineNumberReport(rule: string | undefined, message: string): boolean {
  if (rule === undefined || !ASSIGNABILITY_RULES.has(rule)) return false;
  const [head, ...reasons] = message.split(/\r?\n/).map((line) => line.trim());
  if (reasons.length === 0) return false;
  if (rule === 'reportArgumentType' && RANGE_ARGUMENT.test(head)) {
    // Every non-literal `range()` argument of a Pyne script is truncated to a
    // native int by the runtime before the call
    return reasons.every((reason) => RANGE_REASONS.has(reason));
  }
  let intLeaf = false;
  for (const reason of reasons) {
    if (RESTATEMENTS.some((pattern) => pattern.test(reason))) continue;
    const leaf = LEAF.exec(reason);
    if (!leaf || leaf[1] !== 'float') return false;
    if (leaf[2] === 'int') intLeaf = true;
    else if (!OPTIONAL_TARGET.test(leaf[2])) return false;
  }
  return intLeaf;
}
