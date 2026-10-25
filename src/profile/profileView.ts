/**
 * Profile annotations in the editor.
 *
 * A Profile run shows its result on the measured lines of the script and of
 * every library it ran, in a column left of the code (where TradingView's Pine
 * Profiler puts it): the line's share of the script's time, on a cell whose
 * color deepens with the share. Marks on the
 * overview ruler and a flame on the costliest lines lead to the hot spots.
 * Hovering a line gives its numbers in full, executions included; on a compound
 * statement's header also the whole block's, on a line a `request.security`
 * context ran also each context's. A lens on the first line sums up the run and
 * hides the annotations again.
 *
 * Annotations last as long as the file's content is the one the run measured:
 * an edit makes them disappear (undoing it brings them back). A profile on disk
 * is never shown by itself; when the open script has one that still fits, a lens
 * offers it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { PineSourcemap } from '../api/client';
import type { CompileService } from '../compile/service';
import { loadSourcemapFor } from '../compile/sourcemap';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import { detectPyne, DETECT_HEAD_BYTES, isPythonSyntax } from '../pyneDetect';
import {
  CATEGORY_NAMES,
  formatDuration,
  formatShare,
  loadProfile,
  profilePathFor,
  sourceProfile,
  type Profile,
  type SourceProfile,
} from './profileStore';

/** Heat bands from the hottest down: lower bound of the share of the script's time, in percent. */
const HEAT_BANDS = [
  { min: 10, color: 'hot' },
  { min: 3, color: 'warm' },
  { min: 1, color: 'mild' },
] as const;
/** How many of the costliest lines get a flame. */
const FLAMES = 3;
/** Width of the profile column: the share right-aligned in six (`100.0%`), a space. */
const COLUMN_WIDTH = '7ch';
const COLUMN_MARGIN = '0 1ch 0 0';
/** No-break space: the decoration's CSS would collapse plain ones. */
const NBSP = '\u00a0';

interface LoadedProfile {
  file: string;
  mtimeMs: number;
  profile: Profile;
}

/** The Python file a document's profile lines come from. */
interface ProfileTarget {
  pyPath: string;
  pyText: string;
  map?: PineSourcemap;
}

interface Resolved {
  loaded: LoadedProfile;
  source: SourceProfile;
}

export class ProfileView implements vscode.CodeLensProvider, vscode.HoverProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  /** Profiles shown in the editor, the newest first. */
  private shown: LoadedProfile[] = [];
  /** Profile files read from disk, reused while the file is unchanged. */
  private readonly loaded = new Map<string, LoadedProfile>();
  /** Per document: what it resolved to, for its version and the shown profiles. */
  private readonly resolved = new Map<string, { key: string; value: Resolved | undefined }>();
  /** Bumped whenever the shown profiles change; part of every resolution key. */
  private generation = 0;

  /** Overview ruler marks, one type per heat band. */
  private readonly rulerTypes: vscode.TextEditorDecorationType[];
  /** The profile column; every line of the file carries a cell so the code stays aligned. */
  private readonly columnType: vscode.TextEditorDecorationType;
  private readonly flameType: vscode.TextEditorDecorationType;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly compile: CompileService
  ) {
    this.rulerTypes = HEAT_BANDS.map((band) =>
      vscode.window.createTextEditorDecorationType({
        overviewRulerColor: new vscode.ThemeColor(`pyneide.profile.${band.color}Ruler`),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
      })
    );
    this.columnType = vscode.window.createTextEditorDecorationType({});
    this.flameType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'profile-flame.svg'),
      gutterIconSize: 'contain',
    });
  }

  register(): void {
    const selector = ['python', 'pyne', 'pine'].map((language) => ({ scheme: 'file', language }));
    this.context.subscriptions.push(
      this.changed,
      ...this.rulerTypes,
      this.columnType,
      this.flameType,
      vscode.languages.registerCodeLensProvider(selector, this),
      vscode.languages.registerHoverProvider(selector, this),
      vscode.commands.registerCommand('pyneide.showProfile', (file?: string) =>
        this.showFromCommand(file)
      ),
      vscode.commands.registerCommand('pyneide.hideProfile', (file?: string) => this.hide(file)),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) this.decorate(editor);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!this.shown.length || !e.contentChanges.length) return;
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === e.document) this.decorate(editor);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.resolved.delete(doc.uri.toString()))
    );
  }

  /**
   * Show a profile a run just wrote (or one the user asked for).
   * @returns false when the file is missing or not a profile this version reads.
   */
  show(file: string): boolean {
    const loaded = this.load(file);
    if (!loaded) return false;
    this.shown = [loaded, ...this.shown.filter((entry) => entry.file !== file)];
    this.refresh();
    return true;
  }

  /** Hide one profile's annotations, or every profile's. The files stay. */
  hide(file?: string): void {
    this.shown = file ? this.shown.filter((entry) => entry.file !== file) : [];
    this.refresh();
  }

  private showFromCommand(file?: string): void {
    const doc = vscode.window.activeTextEditor?.document;
    const target = file ?? (doc ? this.offer(doc)?.file : undefined);
    if (!target || !this.show(target)) {
      void vscode.window.showInformationMessage(
        'PyneIDE: no profile fits this file. Profile the script to get one.'
      );
    }
  }

  private refresh(): void {
    this.generation++;
    this.resolved.clear();
    for (const editor of vscode.window.visibleTextEditors) this.decorate(editor);
    this.changed.fire();
  }

  // --- resolution ------------------------------------------------------------

  /** A profile file from disk, reused while it is unchanged. */
  private load(file: string): LoadedProfile | undefined {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      this.loaded.delete(file);
      return undefined;
    }
    const cached = this.loaded.get(file);
    if (cached?.mtimeMs === mtimeMs) return cached;
    const profile = loadProfile(file);
    if (!profile) return undefined;
    const loaded = { file, mtimeMs, profile };
    this.loaded.set(file, loaded);
    return loaded;
  }

  /** Where the profile lines of a document come from; undefined for an unrelated file. */
  private target(doc: vscode.TextDocument): ProfileTarget | undefined {
    if (doc.uri.scheme !== 'file') return undefined;
    try {
      if (doc.languageId === 'pine') {
        // The .py has to be the compile of exactly this text, and its sourcemap
        // has to fit it: otherwise the Pine lines would be guessed
        if (!this.compile.isCompiledFrom(doc)) return undefined;
        const pyPath = doc.uri.fsPath.replace(/\.pine$/, '.py');
        const map = loadSourcemapFor(pyPath);
        if (!map) return undefined;
        return { pyPath: fs.realpathSync(pyPath), pyText: fs.readFileSync(pyPath, 'utf8'), map };
      }
      if (!isPythonSyntax(doc.languageId)) return undefined;
      return { pyPath: fs.realpathSync(doc.uri.fsPath), pyText: doc.getText() };
    } catch {
      return undefined;
    }
  }

  private match(doc: vscode.TextDocument, profiles: LoadedProfile[]): Resolved | undefined {
    if (!profiles.length) return undefined;
    const target = this.target(doc);
    if (!target) return undefined;
    for (const loaded of profiles) {
      const source = sourceProfile(loaded.profile, target.pyPath, target.pyText, target.map);
      if (source) return { loaded, source };
    }
    return undefined;
  }

  /** The shown profile annotating a document, if any. */
  private shownFor(doc: vscode.TextDocument): Resolved | undefined {
    const uri = doc.uri.toString();
    const key = `${doc.version}:${this.generation}`;
    const cached = this.resolved.get(uri);
    if (cached?.key === key) return cached.value;
    const value = this.match(doc, this.shown);
    this.resolved.set(uri, { key, value });
    return value;
  }

  /** The script's own profile on disk when it still fits the document and is not shown. */
  private offer(doc: vscode.TextDocument): LoadedProfile | undefined {
    const isScript =
      doc.languageId === 'pine' ||
      (isPythonSyntax(doc.languageId) &&
        detectPyne(doc.getText().slice(0, DETECT_HEAD_BYTES)) !== undefined);
    if (!isScript) return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const workdir = resolveWorkspaceWorkdir(folder, path.dirname(doc.uri.fsPath));
    if (!workdir?.exists) return undefined;
    const loaded = this.load(profilePathFor(workdir.path, doc.uri.fsPath));
    return loaded && this.match(doc, [loaded]) ? loaded : undefined;
  }

  // --- decorations -----------------------------------------------------------

  private decorate(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const rulers: vscode.DecorationOptions[][] = HEAT_BANDS.map(() => []);
    const column: vscode.DecorationOptions[] = [];
    const flames: vscode.DecorationOptions[] = [];
    const source = this.shownFor(doc)?.source;
    if (source) {
      const measured = [...source.lines].filter(([line]) => line >= 1 && line <= doc.lineCount);
      const hottest = new Set(
        measured
          .filter(([, stat]) => stat.ns > 0)
          .sort((a, b) => b[1].ns - a[1].ns)
          .slice(0, FLAMES)
          .map(([line]) => line)
      );
      for (let index = 0; index < doc.lineCount; index++) {
        const line = index + 1;
        const range = new vscode.Range(index, 0, index, 0);
        const stat = source.lines.get(line);
        if (!stat) {
          column.push({ range, renderOptions: { before: EMPTY_CELL } });
          continue;
        }
        const share = source.scriptNs > 0 ? (stat.ns / source.scriptNs) * 100 : 0;
        const band = HEAT_BANDS.findIndex((candidate) => share >= candidate.min);
        const background = band >= 0 ? `${HEAT_BANDS[band].color}Background` : 'measuredBackground';
        column.push({
          range,
          renderOptions: {
            before: {
              ...EMPTY_CELL,
              contentText: cell(share),
              backgroundColor: new vscode.ThemeColor(`pyneide.profile.${background}`),
            },
          },
        });
        if (band >= 0) rulers[band].push({ range });
        if (hottest.has(line)) flames.push({ range });
      }
    }
    this.rulerTypes.forEach((type, i) => editor.setDecorations(type, rulers[i]));
    editor.setDecorations(this.columnType, column);
    editor.setDecorations(this.flameType, flames);
  }

  // --- hover -----------------------------------------------------------------

  provideHover(doc: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const source = this.shownFor(doc)?.source;
    if (!source) return undefined;
    const line = position.line + 1;
    const stat = source.lines.get(line);
    const contexts = source.contexts.get(line) ?? [];
    if (!stat && !contexts.length) return undefined;
    const block = source.blocks.get(line);
    const total = source.scriptNs;
    const rows: string[] = ['$(flame) **Profile**'];
    if (stat) {
      const label = !source.pine && block?.kind === 'def' ? 'Per-call setup' : 'Time';
      rows.push(`${label}: ${formatDuration(stat.ns)} · ${formatShare(stat.ns, total)} of the script's time`);
      rows.push(`Executions: ${count(stat.hits)}${stat.hits ? ` · ${formatDuration(stat.ns / stat.hits)} each` : ''}`);
    }
    if (block && block.end > block.start) {
      const what = block.kind === 'def' ? 'Function' : `Block (${block.kind})`;
      rows.push(
        `${what}, lines ${block.start}–${block.end}: ${formatDuration(block.ns)} · ` +
          formatShare(block.ns, total)
      );
    }
    if (contexts.length) {
      rows.push('', '**request.security contexts**');
      for (const context of contexts) {
        rows.push(
          `- ${escape(context.timeframe)} on ${escape(context.data)}: ` +
            `${formatDuration(context.ns)}, ${count(context.hits)} executions`
        );
      }
    }
    // The same time shows on every level of a call chain, so the shares add up past 100%
    rows.push('', "*A line's time includes everything it calls, your own functions too.*");
    const markdown = new vscode.MarkdownString(rows.join('  \n'), true);
    return new vscode.Hover(markdown, doc.lineAt(position.line).range);
  }

  // --- lenses ----------------------------------------------------------------

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const range = new vscode.Range(0, 0, 0, 0);
    const shown = this.shownFor(doc);
    if (shown) {
      return [
        new vscode.CodeLens(range, { title: summary(shown.loaded.profile), command: '' }),
        new vscode.CodeLens(range, {
          title: 'Hide',
          command: 'pyneide.hideProfile',
          arguments: [shown.loaded.file],
        }),
      ];
    }
    const offered = this.offer(doc);
    if (!offered) return [];
    return [
      new vscode.CodeLens(range, {
        title: `$(flame) Show profile (${when(offered.mtimeMs)})`,
        command: 'pyneide.showProfile',
        arguments: [offered.file],
      }),
    ];
  }
}

/** The cell of a line the run did not measure: empty, as wide as the others. */
const EMPTY_CELL: vscode.ThemableDecorationAttachmentRenderOptions = {
  contentText: NBSP,
  width: COLUMN_WIDTH,
  margin: COLUMN_MARGIN,
  color: new vscode.ThemeColor('pyneide.profile.annotationForeground'),
};

/** A measured line's cell: its share of the script's time, right-aligned. */
function cell(share: number): string {
  return `${`${share.toFixed(1)}%`.padStart(6, NBSP)}${NBSP}`;
}

/** The lens over a shown profile: bars, run time and where the time went. */
function summary(profile: Profile): string {
  const parts = Object.entries(profile.categories)
    .filter(([, ns]) => ns > 0)
    .map(([key, ns]) => `${CATEGORY_NAMES[key] ?? key} ${formatShare(ns, profile.wall_ns)}`);
  if (profile.contexts.length) {
    const n = profile.contexts.length;
    parts.push(`${n} request.security context${n === 1 ? '' : 's'}`);
  }
  return (
    `$(flame) Profile: ${count(profile.bars)} bars, ${formatDuration(profile.wall_ns)}` +
    (parts.length ? ` — ${parts.join(' · ')}` : '')
  );
}

/** When a profile was written: the time today, the date and time before. */
function when(ms: number): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? `today ${time}`
    : `${date.toLocaleDateString()} ${time}`;
}

function count(n: number): string {
  return n.toLocaleString('en-US');
}

/** Text from the profile file, safe inside markdown. */
function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>$]/g, '\\$&');
}
