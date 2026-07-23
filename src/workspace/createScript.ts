import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { resolveWorkspaceWorkdir } from '../env/workdirConfig';

type ScriptLanguage = 'pine' | 'pyne';
type ScriptKind = 'indicator' | 'strategy' | 'library';

interface ScriptChoice extends vscode.QuickPickItem {
  language: ScriptLanguage;
  scriptKind: ScriptKind;
  snippetFile: 'pine.json' | 'pyne.json';
  snippetName: string;
}

interface SnippetDefinition {
  body: string | string[];
}

const LIBRARY_PUBLISHER_KEY = 'pyneide.libraryPublisher';

const SCRIPT_CHOICES: readonly ScriptChoice[] = [
  {
    label: '$(symbol-color) Pine Indicator',
    description: 'Pine Script v6 · .pine',
    language: 'pine',
    scriptKind: 'indicator',
    snippetFile: 'pine.json',
    snippetName: 'Indicator skeleton',
  },
  {
    label: '$(symbol-color) Pyne Indicator',
    description: 'Pyne code · .py',
    language: 'pyne',
    scriptKind: 'indicator',
    snippetFile: 'pyne.json',
    snippetName: 'Pyne indicator skeleton',
  },
  {
    label: '$(graph-line) Pine Strategy',
    description: 'Pine Script v6 · .pine',
    language: 'pine',
    scriptKind: 'strategy',
    snippetFile: 'pine.json',
    snippetName: 'Strategy skeleton',
  },
  {
    label: '$(graph-line) Pyne Strategy',
    description: 'Pyne code · .py',
    language: 'pyne',
    scriptKind: 'strategy',
    snippetFile: 'pyne.json',
    snippetName: 'Pyne strategy skeleton',
  },
  {
    label: '$(library) Pine Library',
    description: 'Pine Script v6 · .pine',
    language: 'pine',
    scriptKind: 'library',
    snippetFile: 'pine.json',
    snippetName: 'Library skeleton',
  },
  {
    label: '$(library) Pyne Library',
    description: 'Pyne code · .py',
    language: 'pyne',
    scriptKind: 'library',
    snippetFile: 'pyne.json',
    snippetName: 'Pyne library skeleton',
  },
];

/**
 * Create a named script from one of the bundled full-file snippets. Libraries
 * use PyneCore's TradingView-compatible versioned module layout:
 * `scripts/lib/<publisher>/<library>/v<N>.<pine|py>`.
 */
export async function createNewScript(context: vscode.ExtensionContext): Promise<void> {
  const workdir = resolveWorkspaceWorkdir();
  if (!workdir?.exists) {
    void vscode.window.showWarningMessage(
      'PyneIDE: no Pyne workspace found — initialize one first.'
    );
    return;
  }

  const choice = await vscode.window.showQuickPick(SCRIPT_CHOICES, {
    placeHolder: 'What kind of script do you want to create?',
    title: 'New Script',
  });
  if (!choice) return;

  const name = await askScriptName(workdir.path, choice);
  if (!name) return;

  let target: string;
  if (choice.scriptKind === 'library') {
    const publisher = await askLibraryPublisher(context, choice);
    if (!publisher) return;
    const normalizedPublisher = normalizeLibrarySegment(publisher);
    const normalizedName = normalizeLibrarySegment(name);
    const libraryDir = path.join(
      workdir.path,
      'scripts',
      'lib',
      normalizedPublisher,
      normalizedName
    );
    const version = await askLibraryVersion(libraryDir, choice);
    if (version === undefined) return;
    await context.workspaceState.update(LIBRARY_PUBLISHER_KEY, publisher);
    target = path.join(libraryDir, `v${version}${extensionFor(choice)}`);
  } else {
    target = path.join(workdir.path, 'scripts', `${name}${extensionFor(choice)}`);
  }

  try {
    if (scriptStemTaken(target)) {
      throw new Error(`a Pine or Pyne file already exists for ${path.basename(target)}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const rawSnippet = readSnippet(context.extensionPath, choice);
    const snippet =
      choice.language === 'pyne' && choice.scriptKind === 'library'
        ? rawSnippet
        : withScriptName(rawSnippet, name);
    fs.closeSync(fs.openSync(target, 'wx'));
    const uri = vscode.Uri.file(target);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
    });
    const inserted = await editor.insertSnippet(new vscode.SnippetString(snippet));
    if (!inserted) {
      throw new Error('the editor rejected the script template');
    }
    if (!(await document.save())) {
      throw new Error('the new script could not be saved');
    }
    await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
    });
  } catch (err) {
    void vscode.window.showErrorMessage(
      `PyneIDE: could not create the script — ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

function readSnippet(extensionPath: string, choice: ScriptChoice): string {
  const file = path.join(extensionPath, 'snippets', choice.snippetFile);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, SnippetDefinition>;
  const body = parsed[choice.snippetName]?.body;
  if (typeof body === 'string') return body;
  if (Array.isArray(body) && body.every((line) => typeof line === 'string')) {
    return body.join('\n');
  }
  throw new Error(`template "${choice.snippetName}" is missing from ${choice.snippetFile}`);
}

async function askScriptName(
  workdir: string,
  choice: ScriptChoice
): Promise<string | undefined> {
  const library = choice.scriptKind === 'library';
  const defaults: Record<ScriptKind, string> = {
    indicator: 'My Indicator',
    strategy: 'My Strategy',
    library: 'MyLibrary',
  };
  const value = await vscode.window.showInputBox({
    title: library
      ? `New ${languageLabel(choice)} Library — 1/3`
      : `New ${languageLabel(choice)} ${scriptKindLabel(choice.scriptKind)} — 1/1`,
    prompt: library
      ? 'Library name — this becomes the middle segment of its import path'
      : 'Script name — this becomes both the file name and the declaration title',
    value: defaults[choice.scriptKind],
    valueSelection: [0, defaults[choice.scriptKind].length],
    ignoreFocusOut: true,
    validateInput: (input) => {
      const nameError = library ? validateLibrarySegment(input) : validateFileName(input);
      if (nameError) return nameError;
      if (!library) {
        const target = path.join(workdir, 'scripts', `${input.trim()}${extensionFor(choice)}`);
        if (scriptStemTaken(target)) return 'A Pine or Pyne script with this name already exists';
      }
      return undefined;
    },
  });
  return value?.trim();
}

async function askLibraryPublisher(
  context: vscode.ExtensionContext,
  choice: ScriptChoice
): Promise<string | undefined> {
  const previous = context.workspaceState.get<string>(LIBRARY_PUBLISHER_KEY, '');
  const value = await vscode.window.showInputBox({
    title: `New ${languageLabel(choice)} Library — 2/3`,
    prompt: 'Publisher/author — the first segment used by import publisher/library/version',
    placeHolder: 'e.g. my_username',
    value: previous,
    valueSelection: previous ? [0, previous.length] : undefined,
    ignoreFocusOut: true,
    validateInput: validateLibrarySegment,
  });
  return value?.trim();
}

async function askLibraryVersion(
  libraryDir: string,
  choice: ScriptChoice
): Promise<number | undefined> {
  const next = nextLibraryVersion(libraryDir);
  const value = await vscode.window.showInputBox({
    title: `New ${languageLabel(choice)} Library — 3/3`,
    prompt: `Version — saved as ${relativeLibraryPath(libraryDir)}/v<N>`,
    value: String(next),
    valueSelection: [0, String(next).length],
    ignoreFocusOut: true,
    validateInput: (input) => {
      if (!/^[1-9]\d*$/.test(input.trim())) return 'Version must be a positive integer';
      if (!Number.isSafeInteger(Number(input.trim()))) return 'Version number is too large';
      const stem = path.join(libraryDir, `v${input.trim()}`);
      if (scriptStemTaken(`${stem}.pine`)) return `Library version v${input.trim()} already exists`;
      return undefined;
    },
  });
  return value === undefined ? undefined : Number(value.trim());
}

function extensionFor(choice: ScriptChoice): '.pine' | '.py' {
  return choice.language === 'pine' ? '.pine' : '.py';
}

function languageLabel(choice: ScriptChoice): 'Pine' | 'Pyne' {
  return choice.language === 'pine' ? 'Pine' : 'Pyne';
}

function scriptKindLabel(kind: ScriptKind): 'Indicator' | 'Strategy' | 'Library' {
  if (kind === 'indicator') return 'Indicator';
  if (kind === 'strategy') return 'Strategy';
  return 'Library';
}

function validateFileName(input: string): string | undefined {
  const value = input.trim();
  if (!value) return 'Enter a script name';
  if (/\.(?:pine|py)$/i.test(value)) return 'Enter the name without a file extension';
  if (value === '.' || value === '..') return 'Choose a different script name';
  if (/[/\\:*?"<>|\u0000-\u001f]/.test(value)) {
    return 'The name contains a character that cannot be used in a file name';
  }
  if (/[. ]$/.test(value)) return 'The name cannot end with a dot or space';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) {
    return 'This name is reserved by the operating system';
  }
  return undefined;
}

function validateLibrarySegment(input: string): string | undefined {
  const value = input.trim();
  if (!value) return 'Enter a value';
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) {
    return 'Use letters, digits, underscores or hyphens, starting with a letter or underscore';
  }
  return undefined;
}

function normalizeLibrarySegment(value: string): string {
  return value.replaceAll('-', '_');
}

function nextLibraryVersion(libraryDir: string): number {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(libraryDir);
  } catch {
    return 1;
  }
  let highest = 0;
  for (const entry of entries) {
    const match = /^v([1-9]\d*)\.(?:pine|py)$/i.exec(entry);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

function scriptStemTaken(target: string): boolean {
  const stem = target.replace(/\.(?:pine|py)$/i, '');
  const candidates = new Set([`${stem}.pine`, `${stem}.py`]);
  if ([...candidates].some((candidate) => fs.existsSync(candidate))) return true;
  return vscode.workspace.textDocuments.some(
    (document) => candidates.has(document.uri.fsPath)
  );
}

function withScriptName(snippet: string, name: string): string {
  const escaped = name.replaceAll('\\', '\\\\').replaceAll('$', '\\$').replaceAll('}', '\\}');
  return snippet.replace(/\$\{1:[^}]*\}/, `\${1:${escaped}}`);
}

function relativeLibraryPath(libraryDir: string): string {
  const parts = libraryDir.split(path.sep);
  const libIndex = parts.lastIndexOf('lib');
  return libIndex >= 0 ? parts.slice(libIndex).join('/') : libraryDir;
}
