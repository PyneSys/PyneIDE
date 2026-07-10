import * as vscode from 'vscode';
import { PyneDecorationProvider } from './pyneDecorations';

export function activate(context: vscode.ExtensionContext): void {
  new PyneDecorationProvider().register(context);
}

export function deactivate(): void {}
