import * as vscode from 'vscode';

import { DETECT_HEAD_BYTES, detectPyne } from '../pyneDetect';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import {
  parseWorkspaceLibraryImport,
  resolveWorkspaceLibraryFile,
  type LibraryImportSyntax,
  type WorkspaceLibraryImport,
} from './libraryImports';

export interface WorkspaceLibraryReference {
  imported: WorkspaceLibraryImport;
  originSelectionRange: vscode.Range;
}

export function registerLibraryDefinition(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      [{ language: 'pine', scheme: 'file' }, { language: 'python', scheme: 'file' }],
      new LibraryDefinitionProvider()
    )
  );
}

class LibraryDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.LocationLink[] | undefined {
    const workdir = resolveWorkspaceWorkdir();
    if (!workdir?.exists) return undefined;

    const syntax: LibraryImportSyntax = document.languageId === 'pine' ? 'pine' : 'pyne';
    if (
      syntax === 'pyne' &&
      !detectPyne(document.getText().slice(0, DETECT_HEAD_BYTES))
    ) {
      return undefined;
    }

    const reference = workspaceLibraryReferenceAt(document, position, syntax);
    if (!reference) return undefined;
    return definitionLink(
      workdir.path,
      syntax,
      reference.imported,
      reference.originSelectionRange
    );
  }
}

/**
 * Locate a workspace-library reference at a cursor position.
 *
 * Shared with the Pine LS middleware: the native server considers an import
 * declaration its own definition, which must be suppressed when this provider
 * can navigate the same reference to the real versioned module.
 */
export function workspaceLibraryReferenceAt(
  document: vscode.TextDocument,
  position: vscode.Position,
  syntax: LibraryImportSyntax
): WorkspaceLibraryReference | undefined {
  const imports = collectImports(document, syntax);
  const lineImport = imports.find((entry) => entry.line === position.line);
  if (
    lineImport &&
    position.character >= lineImport.imported.pathStart &&
    position.character <= lineImport.imported.pathEnd
  ) {
    return {
      imported: lineImport.imported,
      originSelectionRange: new vscode.Range(
        position.line,
        lineImport.imported.pathStart,
        position.line,
        lineImport.imported.pathEnd
      ),
    };
  }

  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
  if (!wordRange) return undefined;
  const word = document.getText(wordRange);
  const linePrefix = document.lineAt(position.line).text.slice(
    0,
    wordRange.start.character
  );
  const imported = imports.find(
    (entry) =>
      word === entry.imported.alias ||
      (linePrefix.endsWith(`${entry.imported.alias}.`) && word !== entry.imported.alias)
  )?.imported;
  return imported ? { imported, originSelectionRange: wordRange } : undefined;
}

function collectImports(
  document: vscode.TextDocument,
  syntax: LibraryImportSyntax
): { line: number; imported: WorkspaceLibraryImport }[] {
  const imports: { line: number; imported: WorkspaceLibraryImport }[] = [];
  for (let line = 0; line < document.lineCount; line += 1) {
    const imported = parseWorkspaceLibraryImport(document.lineAt(line).text, syntax);
    if (imported) imports.push({ line, imported });
  }
  return imports;
}

function definitionLink(
  workdir: string,
  syntax: LibraryImportSyntax,
  imported: WorkspaceLibraryImport,
  originSelectionRange: vscode.Range
): vscode.LocationLink[] | undefined {
  const target = resolveWorkspaceLibraryFile(workdir, imported, syntax);
  if (!target) return undefined;
  const start = new vscode.Position(0, 0);
  return [
    {
      originSelectionRange,
      targetUri: vscode.Uri.file(target),
      targetRange: new vscode.Range(start, start),
      targetSelectionRange: new vscode.Range(start, start),
    },
  ];
}
