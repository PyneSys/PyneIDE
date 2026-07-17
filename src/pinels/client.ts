import * as vscode from 'vscode';
import {
  LanguageClient,
  RevealOutputChannelOn,
  State,
  type ServerOptions,
} from 'vscode-languageclient/node';

/**
 * Lifecycle wrapper around the LanguageClient talking LSP/stdio to the
 * native pynesys-pine-ls executable (GPL/proprietary process boundary:
 * nothing but standard LSP crosses it).
 */
export class PineLsClient {
  private client?: LanguageClient;
  private executablePath?: string;

  constructor(private readonly output: vscode.OutputChannel) {}

  get running(): boolean {
    return this.client?.state === State.Running;
  }

  get currentExecutable(): string | undefined {
    return this.executablePath;
  }

  /**
   * Start (or switch to) the server binary at `executablePath`.
   * Throws when the server cannot be launched, so the caller can roll back.
   */
  async start(executablePath: string): Promise<void> {
    if (this.client && this.executablePath === executablePath && this.running) return;
    await this.stop();

    // No `transport` here: an explicit TransportKind.stdio makes the client
    // append a `--stdio` argument, which the server's argparse rejects.
    // Leaving it undefined spawns the executable on plain stdio streams.
    const serverOptions: ServerOptions = {
      command: executablePath,
    };
    const client = new LanguageClient('pyneLs', 'Pine Language Server', serverOptions, {
      documentSelector: [{ language: 'pine' }],
      outputChannel: this.output,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
    });
    this.client = client;
    this.executablePath = executablePath;
    await client.start();
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.executablePath = undefined;
    if (!client) return;
    try {
      if (client.state !== State.Stopped) {
        await client.stop(5000);
      }
    } catch {
      // Already dead — nothing to shut down cleanly.
    }
    await client.dispose();
  }

  async restart(): Promise<void> {
    const executable = this.executablePath;
    await this.stop();
    if (executable) await this.start(executable);
  }
}
