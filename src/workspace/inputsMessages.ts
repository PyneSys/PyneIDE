/**
 * Message contract between the input-form webview and its host, plus the
 * `InputSpec` shape the bridge's `--inspect-inputs` mode emits (one entry per
 * pynecore `InputData`).
 */

/** A single input declaration collected from the script's `input.*()` calls. */
export interface InputSpec {
  name: string;
  id: string | null;
  /** pynecore input_type: int/float/bool/string/color/source/enum/... */
  type: string;
  title: string | null;
  defval: string | number | boolean | null;
  minval: number | null;
  maxval: number | null;
  step: number | null;
  options: (string | number)[] | null;
  group: string | null;
  inline: string | null;
  tooltip: string | null;
}

/** A form field value, in the toml's scalar space. */
export type InputValue = string | number | boolean;

export interface InputsPayload {
  /** Display name of the script (basename). */
  script: string;
  scriptType?: string;
  inputs: InputSpec[];
  /** Current values from the sibling toml, keyed by input name. */
  values: Record<string, InputValue>;
  /** Non-fatal note (e.g. no inputs collected). */
  warning?: string | null;
}

export type InputsInMessage =
  | { type: 'data'; payload: InputsPayload }
  | { type: 'saved' }
  | { type: 'error'; message: string };

export type InputsOutMessage =
  | { type: 'ready' }
  | { type: 'save'; values: Record<string, InputValue> };
