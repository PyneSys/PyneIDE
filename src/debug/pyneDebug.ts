/**
 * The `pyne` debug type: debugpy-based Pyne script debugging without any
 * dependency on the ms-python extensions.
 *
 * The bridge process starts a debugpy listener (`--debugpy-port`) and waits
 * for the IDE before running the script; that listener IS the DAP server
 * (debugpy.listen spawns one inside the debuggee), so no adapter process of
 * our own and no ms-python. The descriptor factory puts a thin inline proxy
 * (PyneDapProxy) between VSCode and the endpoint: it injects the script's
 * named persistent/series variables into the Locals scope and feeds debugger
 * execution state back to the RunService for the bar-level controls.
 *
 * Launch configs (`request: "launch"`) are resolved by spawning a bridge run
 * through the RunService (compile + env + workdir + data pipeline, chart
 * streaming included) and rewriting the config to an attach on the endpoint
 * the bridge reports.
 */
import * as vscode from 'vscode';

import type { RunService } from '../run/runService';
import { PyneDapProxy } from './dapProxy';

export function registerPyneDebug(
  context: vscode.ExtensionContext,
  runService: RunService
): void {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('pyne', {
      createDebugAdapterDescriptor(session) {
        const connect = session.configuration.connect as
          | { host?: string; port?: number }
          | undefined;
        if (!connect?.port) {
          throw new Error(
            'PyneIDE: the pyne debug session has no debugpy endpoint (use a launch config).'
          );
        }
        const proxy = new PyneDapProxy(connect.host ?? '127.0.0.1', connect.port, {
          onExecState: (stopped, threadId) => runService.onDebugExecState(stopped, threadId),
        });
        // The proxy owns the debuggee's breakpoints, so the run-to-bar fast
        // path drives suppress/restore through it.
        runService.setDebugControl(proxy);
        return new vscode.DebugAdapterInlineImplementation(proxy);
      },
    }),
    vscode.debug.registerDebugConfigurationProvider('pyne', {
      provideDebugConfigurations(): vscode.DebugConfiguration[] {
        return [initialConfiguration()];
      },
      resolveDebugConfiguration(
        _folder,
        config
      ): vscode.DebugConfiguration | undefined {
        // Empty config: F5 with no launch.json — debug the active editor.
        if (!config.type && !config.request && !config.name) {
          return initialConfiguration();
        }
        return config;
      },
      async resolveDebugConfigurationWithSubstitutedVariables(
        folder,
        config
      ): Promise<vscode.DebugConfiguration | null> {
        if (config.request === 'attach') return config;
        return runService.resolveDebugLaunch(folder, config);
      },
    }),
    // Dynamic provider: offers "Debug Pyne Script" in the Run and Debug
    // dropdown / Quick Pick and lets the green button start a session without
    // ever writing a launch.json.
    vscode.debug.registerDebugConfigurationProvider(
      'pyne',
      {
        provideDebugConfigurations(): vscode.DebugConfiguration[] {
          return [initialConfiguration()];
        },
      },
      vscode.DebugConfigurationProviderTriggerKind.Dynamic
    )
  );
}

function initialConfiguration(): vscode.DebugConfiguration {
  return {
    type: 'pyne',
    request: 'launch',
    name: 'Debug Pyne Script',
    script: '${file}',
  };
}
