"""Round-trip RGBA inputs together with strategy properties through the bridge.

Usage: <managed-python> test/smoke/bridgeInputsSmoke.py <bridge-python-root>
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


with tempfile.TemporaryDirectory(prefix="pyneide-inputs-") as temp:
    workdir = Path(temp)
    (workdir / "scripts").mkdir()
    script = workdir / "scripts" / "colors.py"
    script.write_text('''"""@pyne"""
from pynecore.lib import script, input, color, plot, close

@script.strategy("Color inputs", overlay=True)
def main(tint=input.color(color.new(color.green, 50), "Tint")):
    plot(close, color=tint)
''')
    env = {**os.environ, "PYTHONPATH": sys.argv[1]}

    def bridge(mode, payload=None):
        result = subprocess.run(
            [sys.executable, "-m", "pyneide_bridge", "--workdir", str(workdir), mode, "colors"],
            input=json.dumps(payload) if payload is not None else "", text=True,
            capture_output=True, env=env, timeout=30,
        )
        events = [json.loads(line) for line in result.stdout.splitlines()]
        assert result.returncode == 0, events
        return events[-1]

    defaults = bridge("--inspect-inputs")
    spec = defaults["inputs"][0]
    assert spec["type"] == "color", spec
    assert spec["defval"] == "#4CAF5080", spec
    assert spec["value"] == spec["defval"], spec
    bridge("--write-inputs", {"values": {"tint": spec["value"]},
                              "properties": {"commission_value": 0.1}})
    saved = bridge("--inspect-inputs")
    assert saved["inputs"][0]["value"] == spec["value"], saved
    assert saved["properties"]["commission_value"]["value"] == 0.1, saved
    bridge("--write-inputs", {"values": {"tint": "#12345678"}})
    assert bridge("--inspect-inputs")["inputs"][0]["value"] == "#12345678"
    bridge("--write-inputs", {"values": {"tint": "#ABCDEF"}})
    assert bridge("--inspect-inputs")["inputs"][0]["value"] == "#ABCDEF"
    print("BRIDGE INPUTS SMOKE OK: default alpha, unchanged color + commission, RGBA/RGB edits")
