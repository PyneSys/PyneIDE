import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Mirror of pynecore's AppState._find_workdir: walk upwards from `startDir`
 * (max 10 levels) looking for a directory named `workdir`; when none is
 * found, fall back to `<startDir>/workdir` (which may not exist yet).
 */
export function findWorkdir(startDir: string): { path: string; exists: boolean } {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 10; depth++) {
    const candidate = path.join(current, 'workdir');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return { path: candidate, exists: true };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { path: path.join(path.resolve(startDir), 'workdir'), exists: false };
}

export const WORKDIR_SUBDIRS = ['scripts', 'data', 'config', 'output'] as const;

const DEMO_SCRIPT = `"""
@pyne

Demo indicator: fast SMA and slow EMA on the chart.
"""
from pynecore.lib import close, color, input, plot, script, ta


@script.indicator("Demo — Moving Averages", overlay=True)
def main(
    fast_len=input.int(9, "Fast length", minval=1),
    slow_len=input.int(21, "Slow length", minval=1),
):
    fast = ta.sma(close, fast_len)
    slow = ta.ema(close, slow_len)
    plot(fast, "Fast SMA", color=color.aqua)
    plot(slow, "Slow EMA", color=color.orange)
`;

const WORKDIR_README = `# Pyne workdir

Created by PyneIDE. Layout (used by the \`pyne\` CLI and PyneCore):

- scripts/ - Pyne scripts (.py with a docstring starting with @pyne) and .pine sources
- data/    - OHLCV data files (.ohlcv + .toml symbol info)
- config/  - provider credentials and configuration
- output/  - run results (plot/strategy/trade CSV files)

Download data for a script, e.g.:

    pyne data download ccxt --symbol "BYBIT:BTC/USDT:USDT" --timeframe 1D

Then run it:

    pyne run demo_moving_averages.py
`;

export interface CreatedWorkspace {
  workdir: string;
  demoScript: string;
  created: boolean;
}

/**
 * Create the pynecore-compatible workdir structure with a demo script.
 * Existing files are never overwritten.
 */
export function createPyneWorkspace(baseDir: string): CreatedWorkspace {
  const workdir = path.join(baseDir, 'workdir');
  const existed = fs.existsSync(workdir);
  for (const sub of WORKDIR_SUBDIRS) {
    fs.mkdirSync(path.join(workdir, sub), { recursive: true });
  }
  const readmePath = path.join(workdir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, WORKDIR_README);
  }
  const demoScript = path.join(workdir, 'scripts', 'demo_moving_averages.py');
  if (!fs.existsSync(demoScript)) {
    fs.writeFileSync(demoScript, DEMO_SCRIPT);
  }
  return { workdir, demoScript, created: !existed };
}
