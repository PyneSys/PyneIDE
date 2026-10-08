"""Metadata feed smoke tests against a local Core and the Python bridge.

Run with a Python that can import pynecore. An optional first argument selects
the bridge's Python source directory; otherwise use this checkout's python/.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

bridge_root = Path(sys.argv.pop(1)) if len(sys.argv) > 1 else Path(__file__).parents[2] / 'python'
sys.path.insert(0, str(bridge_root))

from pynecore import lib
from pynecore.core import viz
from pynecore.types.color import Color
from pynecore.types.plot_meta import PlotMeta
from pyneide_bridge.runner import _VizTap


class Capture:
    def __init__(self):
        self.events = []

    def emit(self, event):
        self.events.append(event)


class MetadataFeedSmoke(unittest.TestCase):
    def setUp(self):
        viz.reset_state()
        self.addCleanup(viz.reset_state)

    @unittest.skipUnless(callable(getattr(viz, 'collect_meta_changes', None)),
                         'Core metadata feed unavailable')
    def test_native_writer_and_bridge_share_changes_and_serialization(self):
        color = Color('FF0000')
        meta = PlotMeta(id='p', kind='plot', color=color)
        lib._plot_meta['p'] = meta
        lib._plot_meta_new.append(meta)
        first = _VizTap(lib)
        second = _VizTap(lib)
        self.assertIsNotNone(first._meta_changes)
        original = viz.serialize_meta
        calls = []

        def serialize(value):
            calls.append(value.id)
            return original(value)

        with tempfile.TemporaryDirectory() as tmp, patch.object(viz, 'serialize_meta', serialize):
            writer = viz.VizWriter(Path(tmp) / 'out.ndjson')
            writer.open()
            try:
                writer.write_bar(0, 0, {'p': 100}, {})
                self.assertEqual(lib._plot_meta_new, [])
                first.drain_metas()
                second.drain_metas()
                self.assertEqual(calls, ['p'])
                self.assertEqual(first._metas, second._metas)
                first._metas.clear()
                second._metas.clear()
                for _ in range(10):
                    first.drain_metas()
                    second.drain_metas()
                self.assertEqual(calls, ['p'])
                self.assertEqual(first._metas, {})
                meta.dynamic = True
                lib._plot_meta_new.append(meta)
                writer.write_bar(1, 300000, {'p': 101}, {})
                first.drain_metas()
                second.drain_metas()
                self.assertEqual(calls, ['p', 'p'])
                self.assertTrue(first._metas['p']['dynamic'])
                color.a = 30
                writer.write_bar(2, 600000, {'p': 102}, {})
                first.drain_metas()
                second.drain_metas()
                self.assertEqual(calls, ['p', 'p', 'p'])
                self.assertEqual(first._metas, second._metas)
                self.assertEqual(first._metas['p']['color'], viz.color_str(color))
            finally:
                writer.close()
            records = [json.loads(line) for line in writer.path.read_text().splitlines()]
            self.assertEqual([record['t'] for record in records],
                             ['meta', 'bar', 'meta', 'bar', 'meta', 'bar'])
            self.assertEqual(records[-2], first._metas['p'])
            capture = Capture()
            first.emit_metas(capture)
            self.assertEqual(capture.events[0]['e'], 'plotMeta')

    def test_older_core_uses_registry_fallback(self):
        meta = PlotMeta(id='p', kind='plot', color=Color('FF0000'))
        lib._plot_meta['p'] = meta
        with patch.object(viz, 'collect_meta_changes', None):
            tap = _VizTap(lib)
        self.assertTrue(tap.active)
        self.assertIsNone(tap._meta_changes)
        tap.drain_metas()
        self.assertEqual(tap._metas['p']['id'], 'p')
        tap._metas.clear()
        tap.drain_metas()
        self.assertEqual(tap._metas, {})
        meta.color.a = 60
        tap.drain_metas()
        self.assertEqual(tap._metas['p']['color'], viz.color_str(meta.color))

    def test_run_reset_drops_previous_color_references(self):
        old_color = Color('FF0000')
        lib._plot_meta['p'] = PlotMeta(id='p', kind='plot', color=old_color)
        first = _VizTap(lib)
        first.drain_metas()
        viz.reset_state()
        lib._plot_meta['p'] = PlotMeta(id='p', kind='plot', color=Color('0000FF'))
        second = _VizTap(lib)
        second.drain_metas()
        second._metas.clear()
        old_color.a = 10
        second.drain_metas()
        self.assertEqual(second._metas, {})


if __name__ == '__main__':
    unittest.main()
