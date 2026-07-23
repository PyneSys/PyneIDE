import * as vscode from 'vscode';

import { DETECT_HEAD_BYTES, detectPyne } from '../pyneDetect';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import {
  collectWorkspaceLibraryImports,
  discoverWorkspaceLibraries,
  libraryMemberFragment,
  pineImportFragment,
  pyneImportFragment,
  readWorkspaceLibraryExports,
  resolveWorkspaceLibraryFile,
  type ImportFragment,
  type LibraryImportSyntax,
  type WorkspaceLibrary,
  type WorkspaceLibraryExport,
  type WorkspaceLibraryImport,
} from './libraryImports';
import { libraryExportMarkdown } from './libraryHelp';

export function registerLibraryCompletion(context: vscode.ExtensionContext): void {
  const provider = new LibraryCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      [{ language: 'pine', scheme: 'file' }, { language: 'python', scheme: 'file' }],
      provider,
      '/',
      '.',
      ' '
    )
  );
}

class LibraryCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    const workdir = resolveWorkspaceWorkdir();
    if (!workdir?.exists) return undefined;

    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const syntax: LibraryImportSyntax = document.languageId === 'pine' ? 'pine' : 'pyne';
    if (
      syntax === 'pyne' &&
      !detectPyne(document.getText().slice(0, DETECT_HEAD_BYTES))
    ) {
      return undefined;
    }

    const member = libraryMemberFragment(linePrefix, syntax);
    if (member) {
      const imported = collectImports(document, syntax)
        .reverse()
        .find((entry) => entry.alias === member.alias);
      if (!imported) return undefined;
      const source = resolveWorkspaceLibraryFile(workdir.path, imported, syntax);
      if (!source) return undefined;
      const range = new vscode.Range(
        position.line,
        member.start,
        position.line,
        position.character
      );
      return readWorkspaceLibraryExports(source).map((entry, index) =>
        exportCompletion(entry, imported, syntax, range, index)
      );
    }

    let fragment: ImportFragment | undefined;
    let importPath: (library: WorkspaceLibrary) => string;
    if (syntax === 'pine') {
      fragment = pineImportFragment(linePrefix);
      importPath = (library) => library.pineImport;
    } else {
      fragment = pyneImportFragment(linePrefix);
      if (!fragment) return undefined;
      importPath = (library) => library.pyneImport;
    }
    if (!fragment) return undefined;

    const range = new vscode.Range(
      position.line,
      fragment.start,
      position.line,
      position.character
    );
    return discoverWorkspaceLibraries(workdir.path).map((library, index) => {
      const value = importPath(library);
      const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Module);
      item.range = range;
      item.insertText = value;
      item.filterText = value;
      item.sortText = String(index).padStart(8, '0');
      item.detail = `${languageSummary(library)} workspace library`;
      item.documentation = new vscode.MarkdownString(
        `Import **${library.publisher}/${library.name}**, version ${library.version}.`
      );
      return item;
    });
  }
}

function collectImports(
  document: vscode.TextDocument,
  syntax: LibraryImportSyntax
): WorkspaceLibraryImport[] {
  return collectWorkspaceLibraryImports(document.getText(), syntax);
}

function exportCompletion(
  entry: WorkspaceLibraryExport,
  imported: WorkspaceLibraryImport,
  syntax: LibraryImportSyntax,
  range: vscode.Range,
  index: number
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    entry.name,
    entry.kind === 'method'
      ? vscode.CompletionItemKind.Method
      : vscode.CompletionItemKind.Function
  );
  item.range = range;
  item.insertText = entry.name;
  item.filterText = entry.name;
  item.sortText = String(index).padStart(8, '0');
  item.detail =
    `${entry.signature} — exported ${entry.kind} from ` +
    `${imported.publisher}/${imported.name}/${imported.version}`;
  item.documentation = libraryExportMarkdown(entry, syntax);
  return item;
}

function languageSummary(library: WorkspaceLibrary): string {
  if (library.languages.length === 2) return 'Pine + Pyne';
  return library.languages[0] === 'pine' ? 'Pine' : 'Pyne';
}
