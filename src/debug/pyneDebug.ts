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
import { PineSourceMapper } from './sourceMapper';

export function registerPyneDebug(
  context: vscode.ExtensionContext,
  runService: RunService
): void {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('pyne', {
      async createDebugAdapterDescriptor(session) {
        // Minted here (not from the config) so a restart — which reuses the
        // resolved attach config with a now-dead port and re-invokes this
        // factory — spawns a fresh bridge instead of dialling the corpse.
        const ep = await runService.acquireDebugEndpoint(session.configuration);
        if (!ep) {
          throw new Error(
            'PyneIDE: the pyne debug session has no debugpy endpoint (use a launch config).'
          );
        }
        // A .pine launch debugs at the Pine level: breakpoints, frames and
        // stepping are translated through the compile-time sourcemap. When the
        // map is missing or stale (e.g. the compiled .py was hand-edited), the
        // session still runs — as a plain Python-level debug of the .py.
        let mapper: PineSourceMapper | undefined;
        const pineSource = session.configuration.pineSource;
        if (typeof pineSource === 'string') {
          mapper = new PineSourceMapper();
          if (!mapper.hasPineMapping(pineSource)) {
            mapper = undefined;
            void vscode.window.showWarningMessage(
              'PyneIDE: no valid sourcemap for this Pine script — debugging the compiled ' +
                'Python instead. Recompile the .pine to restore Pine-level debugging.'
            );
          }
        }
        const proxy = new PyneDapProxy(
          ep.host,
          ep.port,
          {
            onExecState: (stopped, threadId) => runService.onDebugExecState(stopped, threadId),
            onFastChartBreakpointsChanged: (timestamps) =>
              runService.onFastChartBreakpointsChanged(timestamps),
          },
          mapper
        );
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
    // Dynamic provider: offers "Debug Pyne code" in the Run and Debug
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
    name: 'Debug Pyne code',
    script: '${file}',
  };
}
