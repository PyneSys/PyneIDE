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

/** A strategy setting (a `[script]` toml field): the value the script itself
 * declares and the one in effect after the toml. `value !== default` is an
 * override. */
export interface PropertyState {
  default: InputValue | null;
  value: InputValue | null;
}

/** The form's tabs; `properties` exists for strategies only. */
export type InputsTab = 'inputs' | 'properties';

export interface InputsPayload {
  /** Display name of the script (basename). */
  script: string;
  scriptType?: string;
  inputs: InputSpec[];
  /** Current values from the sibling toml, keyed by input name. */
  values: Record<string, InputValue>;
  /** Strategy settings keyed by `[script]` field name; absent for indicators. */
  properties?: Record<string, PropertyState> | null;
  /** The tab to show first. */
  tab?: InputsTab;
  /** Non-fatal note (e.g. no inputs collected). */
  warning?: string | null;
}

export type InputsInMessage =
  | { type: 'data'; payload: InputsPayload }
  | { type: 'showTab'; tab: InputsTab }
  | { type: 'saved' }
  | { type: 'error'; message: string };

export type InputsOutMessage =
  | { type: 'ready' }
  | {
      type: 'save';
      values: Record<string, InputValue>;
      /** Strategy settings shown in the form; one equal to its default is no override. */
      properties?: Record<string, InputValue>;
    };
