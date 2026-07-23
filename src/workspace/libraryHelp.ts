import * as vscode from 'vscode';

import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import { DETECT_HEAD_BYTES, detectPyne } from '../pyneDetect';
import {
  activeLibraryCall,
  collectWorkspaceLibraryImports,
  libraryMemberFragment,
  libraryParameterName,
  librarySignatureParameters,
  parseLibraryDocumentation,
  readWorkspaceLibraryExports,
  resolveWorkspaceLibraryFile,
  type LibraryImportSyntax,
  type WorkspaceLibraryExport,
} from './libraryImports';

interface ResolvedLibraryExport {
  entry: WorkspaceLibraryExport;
}

export function registerLibraryHelp(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = [
    { language: 'pine', scheme: 'file' },
    { language: 'python', scheme: 'file' },
  ];
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, new LibraryHoverProvider()),
    vscode.languages.registerSignatureHelpProvider(
      selector,
      new LibrarySignatureHelpProvider(),
      '(',
      ','
    )
  );
}

class LibraryHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    const syntax = librarySyntax(document);
    if (!syntax) return undefined;
    const wordRange = document.getWordRangeAtPosition(
      position,
      /[A-Za-z_][A-Za-z0-9_]*/
    );
    if (!wordRange) return undefined;
    const linePrefix = document.lineAt(position.line).text.slice(
      0,
      wordRange.end.character
    );
    const member = libraryMemberFragment(linePrefix, syntax);
    if (!member || member.text !== document.getText(wordRange)) return undefined;
    const resolved = resolveExport(document, syntax, member.alias, member.text);
    if (!resolved) return undefined;
    return new vscode.Hover(libraryExportMarkdown(resolved.entry, syntax), wordRange);
  }
}

class LibrarySignatureHelpProvider implements vscode.SignatureHelpProvider {
  provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.SignatureHelp> {
    const syntax = librarySyntax(document);
    if (!syntax) return undefined;
    const prefix = document.getText(
      new vscode.Range(new vscode.Position(0, 0), position)
    );
    const call = activeLibraryCall(prefix, syntax);
    if (!call) return undefined;
    const resolved = resolveExport(document, syntax, call.alias, call.member);
    if (!resolved) return undefined;

    const parsed = parseLibraryDocumentation(resolved.entry.documentation);
    const signatureSyntax = resolved.entry.signatureSyntax ?? syntax;
    const signature = new vscode.SignatureInformation(
      resolved.entry.signature,
      signatureDocumentation(parsed.summary, parsed.returns)
    );
    signature.parameters = librarySignatureParameters(resolved.entry.signature).map(
      (label) => {
        const name = libraryParameterName(label, signatureSyntax);
        return new vscode.ParameterInformation(
          label,
          name ? parsed.parameters[name] : undefined
        );
      }
    );

    const help = new vscode.SignatureHelp();
    help.signatures = [signature];
    help.activeSignature = 0;
    help.activeParameter =
      signature.parameters.length === 0
        ? 0
        : Math.min(call.activeParameter, signature.parameters.length - 1);
    return help;
  }
}

function librarySyntax(document: vscode.TextDocument): LibraryImportSyntax | undefined {
  if (document.languageId === 'pine') return 'pine';
  if (
    document.languageId === 'python' &&
    detectPyne(document.getText().slice(0, DETECT_HEAD_BYTES))
  ) {
    return 'pyne';
  }
  return undefined;
}

function resolveExport(
  document: vscode.TextDocument,
  syntax: LibraryImportSyntax,
  alias: string,
  member: string
): ResolvedLibraryExport | undefined {
  const workdir = resolveWorkspaceWorkdir();
  if (!workdir?.exists) return undefined;
  const imported = collectWorkspaceLibraryImports(document.getText(), syntax)
    .reverse()
    .find((entry) => entry.alias === alias);
  if (!imported) return undefined;
  const source = resolveWorkspaceLibraryFile(workdir.path, imported, syntax);
  if (!source) return undefined;
  const entry = readWorkspaceLibraryExports(source).find(
    (candidate) => candidate.name === member
  );
  return entry ? { entry } : undefined;
}

export function libraryExportMarkdown(
  entry: WorkspaceLibraryExport,
  syntax: LibraryImportSyntax
): vscode.MarkdownString {
  const parsed = parseLibraryDocumentation(entry.documentation);
  const signatureSyntax = entry.signatureSyntax ?? syntax;
  const markdown = new vscode.MarkdownString();
  markdown.appendCodeblock(
    entry.signature,
    signatureSyntax === 'pine' ? 'pine' : 'python'
  );
  if (parsed.summary) markdown.appendMarkdown(parsed.summary);

  const documentedParameters = librarySignatureParameters(entry.signature)
    .map((label) => {
      const name = libraryParameterName(label, signatureSyntax);
      return {
        name,
        documentation: name ? parsed.parameters[name] : undefined,
      };
    })
    .filter(
      (parameter): parameter is { name: string; documentation: string } =>
        Boolean(parameter.name && parameter.documentation)
    );
  if (documentedParameters.length > 0) {
    markdown.appendMarkdown('\n\n**Parameters**\n\n');
    for (const parameter of documentedParameters) {
      markdown.appendMarkdown(
        `- \`${parameter.name}\` — ${parameter.documentation}\n`
      );
    }
  }
  if (parsed.returns) {
    markdown.appendMarkdown(`\n\n**Returns**\n\n${parsed.returns}`);
  }
  return markdown;
}

function signatureDocumentation(
  summary: string | undefined,
  returns: string | undefined
): string | undefined {
  if (!summary && !returns) return undefined;
  return [summary, returns ? `Returns: ${returns}` : undefined]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}
