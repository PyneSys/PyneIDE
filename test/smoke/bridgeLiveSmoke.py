"""Live chart (``--live``) smoke tests of the bridge, offline.

The history comes from PyneCore's fixture-fed ``replay`` provider. One test
runs the bridge process end to end and stops it from stdin; the other runs
it in-process on a scripted live feed, which holds every update back until
the previous one was streamed, so the forming-bar ticks are deterministic.

Usage: <managed-python> test/smoke/bridgeLiveSmoke.py [bridge-python-root]
A PyneCore without live chart support skips the tests.
"""
import itertools
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

bridge_root = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else Path(__file__).parents[2] / 'python'
sys.path.insert(0, str(bridge_root))

from pyneide_bridge.live import live_supported, run_live  # noqa: E402

SCRIPT = '''"""@pyne"""
from pynecore.lib import script, plot, close


@script.indicator("Live smoke", overlay=True)
def main():
    plot(close, "close")
'''

MINUTE = 60_000


def make_workdir(temp: Path, live_rows: list) -> tuple[Path, int]:
    """A workdir with the script and a replay fixture of 10 closed minutes."""
    last_ts = (int(time.time()) // 60 - 2) * MINUTE
    warmup = [[last_ts - (9 - i) * MINUTE, 100.0 + i, 101.0 + i, 99.0 + i, 100.0 + i, 1.0]
              for i in range(10)]
    fixture = temp / 'fixture.json'
    fixture.write_text(json.dumps({'warmup': warmup, 'live': live_rows}), encoding='utf-8')
    (temp / 'scripts').mkdir()
    (temp / 'scripts' / 'smoke.py').write_text(SCRIPT, encoding='utf-8')
    (temp / 'config' / 'plugins').mkdir(parents=True)
    (temp / 'config' / 'plugins' / 'replay.toml').write_text(
        f'fixture_path = "{fixture.as_posix()}"\n', encoding='utf-8')
    return temp, last_ts


class Capture:
    def __init__(self):
        self.events = []
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)

    def emit(self, event):
        with self.changed:
            self.events.append(event)
            self.changed.notify_all()

    def wait_for(self, predicate, timeout=10.0):
        with self.changed:
            if not self.changed.wait_for(lambda: predicate(self.events), timeout):
                raise AssertionError(f'timed out; events: {self.events}')


def candle(ts, close, closed):
    from pynecore.types.ohlcv import OHLCV
    return OHLCV(timestamp=ts, open=110.0, high=max(110.0, close), low=min(110.0, close),
                 close=close, volume=1.0, is_closed=closed)


def ticks(events):
    return [ev for ev in events if ev['e'] == 'tick']


@unittest.skipIf(live_supported() is not None, 'PyneCore without live chart support')
class LiveSmoke(unittest.TestCase):
    def test_process_downloads_goes_live_and_stops(self):
        """The bridge process downloads the history, runs it, goes live, and a
        cancel on stdin stops it while it waits for the next update"""
        with tempfile.TemporaryDirectory(prefix='pyneide-live-') as temp:
            workdir, last_ts = make_workdir(Path(temp), [])
            env = {**os.environ, 'PYTHONPATH': str(bridge_root)}
            proc = subprocess.Popen(
                [sys.executable, '-m', 'pyneide_bridge', '--workdir', str(workdir),
                 '--script', 'smoke', '--live', 'replay:TEST@1', '--live-from', '-5'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                env=env, text=True)
            events = []
            try:
                for line in proc.stdout:
                    events.append(json.loads(line))
                    if events[-1]['e'] in ('live', 'error'):
                        break
                started = time.monotonic()
                proc.stdin.write('{"cmd": "cancel"}\n')
                proc.stdin.flush()
                events.extend(json.loads(line) for line in proc.stdout)
                self.assertEqual(proc.wait(timeout=30), 0, events)
                self.assertLess(time.monotonic() - started, 10.0)
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.stdin.close()
                proc.stdout.close()
            # The history is kept in memory: nothing goes into the workdir's data
            self.assertFalse((workdir / 'data').exists())

        kinds = [ev['e'] for ev in events]
        self.assertNotIn('error', kinds, events)
        self.assertIn('download', kinds)
        start = next(ev for ev in events if ev['e'] == 'start')
        self.assertEqual(start['live'], {'provider': 'replay:TEST@1', 'historyTrades': False})
        self.assertEqual(start['range']['bars'], 5)
        closes = [row[4] for ev in events if ev['e'] == 'bars' for row in ev['d']]
        self.assertEqual(closes, [105.0, 106.0, 107.0, 108.0, 109.0])
        self.assertLess(kinds.index('bars'), kinds.index('live'))
        states = [ev['state'] for ev in events if ev['e'] == 'feedStatus']
        self.assertEqual(states[0], 'connecting')
        self.assertEqual(states[-1], 'stopped')
        self.assertEqual(events[-1], {'e': 'end', 'bars': 5, 'cancelled': True})

    def test_live_with_backtest_options_is_refused(self):
        with tempfile.TemporaryDirectory(prefix='pyneide-live-') as temp:
            workdir, _ = make_workdir(Path(temp), [])
            result = subprocess.run(
                [sys.executable, '-m', 'pyneide_bridge', '--workdir', str(workdir),
                 '--script', 'smoke', '--live', 'replay:TEST@1', '--data', 'x'],
                input='', capture_output=True, text=True, timeout=60,
                env={**os.environ, 'PYTHONPATH': str(bridge_root)})
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(result.returncode, 1)
        self.assertIn('--data cannot be used with --live', events[-1]['message'])

    def test_cancel_ends_the_download_retry_wait(self):
        """A cancel during the backoff before a download retry ends the run at once"""
        from pynecore.core.plugin import TransientProviderError
        from pyneide_bridge.control import Control

        def unavailable(*_args, **_kwargs):
            raise TransientProviderError('venue unavailable')

        capture = Capture()
        control = Control()
        with tempfile.TemporaryDirectory(prefix='pyneide-live-') as temp:
            workdir, _ = make_workdir(Path(temp), [])
            args = SimpleNamespace(
                workdir=str(workdir), script='smoke', live='replay:TEST@1', live_from='-5',
                history_trades=False, live_output_limit=None, batch_size=500)
            canceller = threading.Thread(target=lambda: (
                capture.wait_for(lambda evs: any(ev.get('step') == 'retry' for ev in evs)),
                control.cancel()), daemon=True)
            canceller.start()
            started = time.monotonic()
            with patch('pynecore.core.provider_download.download_provider_history', unavailable):
                self.assertEqual(run_live(args, capture, control), 0)
            canceller.join(timeout=10)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(capture.events[-1], {'e': 'end', 'bars': 0, 'cancelled': True})

    def test_forming_bar_ticks_are_streamed_and_superseded_by_the_close(self):
        """Ticks reach the chart throttled, the latest one wins, and the close
        drops a tick still held back"""
        from pynecore.core.script_runner import LIVE_TRANSITION
        from pyneide_bridge.control import Control

        capture = Capture()
        with tempfile.TemporaryDirectory(prefix='pyneide-live-') as temp:
            workdir, last_ts = make_workdir(Path(temp), [])
            ts = last_ts + MINUTE

            def scripted_feed(_history, *, last_historical_timestamp, on_feed_status=None,
                              stop=None):
                yield LIVE_TRANSITION
                capture.wait_for(lambda evs: any(ev['e'] == 'live' for ev in evs))
                yield candle(ts, 111.0, False)
                capture.wait_for(lambda evs: len(ticks(evs)) == 1)
                # Within the throttle interval: 112 is overtaken by 113, which
                # the timer sends once the interval is over
                yield candle(ts, 112.0, False)
                yield candle(ts, 113.0, False)
                capture.wait_for(lambda evs: len(ticks(evs)) == 2)
                # Held back, then superseded by the close
                yield candle(ts, 114.0, False)
                yield candle(ts, 115.0, True)

            args = SimpleNamespace(
                workdir=str(workdir), script='smoke', live='replay:TEST@1', live_from='-5',
                history_trades=False, live_output_limit=None, batch_size=500)
            with patch('pynecore.core.provider_download.open_live_stream', scripted_feed):
                self.assertEqual(run_live(args, capture, Control()), 0)

        events = capture.events
        tick_closes = [ev['d'][4] for ev in ticks(events)]
        self.assertEqual(tick_closes, [111.0, 113.0])
        self.assertTrue(all(ev['ran'] for ev in ticks(events)))
        plots = [ev['d'][6] for ev in ticks(events)]
        self.assertEqual(plots, [[111.0], [113.0]])
        rows = [row for ev in events if ev['e'] == 'bars' for row in ev['d']]
        self.assertEqual(rows[-1][0], ts)
        self.assertEqual(rows[-1][4], 115.0)
        kinds = [ev['e'] for ev in events]
        self.assertGreater(kinds.index('bars', kinds.index('live')), max(
            i for i, kind in enumerate(kinds) if kind == 'tick'))
        self.assertEqual(events[-1], {'e': 'end', 'bars': 6, 'cancelled': False})

    def test_output_files_end_at_the_size_limit_and_the_chart_goes_on(self):
        """At the size limit the plot CSV and viz NDJSON end as complete records
        at the bar of the limit, while the later bars still reach the chart"""
        from pynecore.core.script_runner import LIVE_TRANSITION
        from pyneide_bridge.control import Control

        capture = Capture()
        with tempfile.TemporaryDirectory(prefix='pyneide-live-') as temp:
            workdir, last_ts = make_workdir(Path(temp), [])

            def scripted_feed(_history, *, last_historical_timestamp, on_feed_status=None,
                              stop=None):
                yield LIVE_TRANSITION
                for i in range(1, 4):
                    yield candle(last_ts + i * MINUTE, 110.0 + i, True)

            args = SimpleNamespace(
                workdir=str(workdir), script='smoke', live='replay:TEST@1', live_from='-5',
                history_trades=False, live_output_limit=1, batch_size=500)
            # 1 "MB" of 1 byte: the history alone is over the limit
            with patch('pynecore.core.provider_download.open_live_stream', scripted_feed), \
                    patch('pyneide_bridge.live.BYTES_PER_MB', 1):
                self.assertEqual(run_live(args, capture, Control()), 0)
            csv_rows = (workdir / 'output' / 'smoke.csv').read_text().splitlines()[1:]
            viz = [json.loads(line) for line in
                   (workdir / 'output' / 'smoke_viz.ndjson').read_text().splitlines()]

        events = capture.events
        # The 5 history bars and the first live close are saved, the rest is not
        self.assertEqual(len(csv_rows), 6)
        self.assertEqual(sum(1 for rec in viz if rec['t'] == 'bar'), 6)
        self.assertEqual(viz[-1], {'t': 'end', 'bars': 6})
        warnings = [ev['message'] for ev in events if ev['e'] == 'log']
        self.assertEqual(len(warnings), 1)
        self.assertIn('reached 1 MB', warnings[0])
        closes = [row[4] for ev in events if ev['e'] == 'bars' for row in ev['d']]
        self.assertEqual(closes[-3:], [111.0, 112.0, 113.0])
        self.assertEqual(events[-1], {'e': 'end', 'bars': 8, 'cancelled': False})


if __name__ == '__main__':
    unittest.main()
