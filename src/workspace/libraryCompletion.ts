import * as vscode from 'vscode';

import { DETECT_HEAD_BYTES, detectPyne } from '../pyneDetect';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import {
  discoverWorkspaceLibraries,
  pineImportFragment,
  pyneImportFragment,
  type ImportFragment,
  type WorkspaceLibrary,
} from './libraryImports';

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
    let fragment: ImportFragment | undefined;
    let importPath: (library: WorkspaceLibrary) => string;
    if (document.languageId === 'pine') {
      fragment = pineImportFragment(linePrefix);
      importPath = (library) => library.pineImport;
    } else {
      fragment = pyneImportFragment(linePrefix);
      if (!fragment || !detectPyne(document.getText().slice(0, DETECT_HEAD_BYTES))) {
        return undefined;
      }
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

function languageSummary(library: WorkspaceLibrary): string {
  if (library.languages.length === 2) return 'Pine + Pyne';
  return library.languages[0] === 'pine' ? 'Pine' : 'Pyne';
}
