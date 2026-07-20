"""PyneIDE runner bridge.

Runs a Pyne script through pynecore's ScriptRunner and streams the results
as NDJSON events on a dedicated protocol stream (the process's original
stdout), while everything else the script or pynecore prints is diverted to
stderr. Control commands (pause/resume/step/cancel) arrive as JSON lines on
stdin.

The package is shipped inside the PyneIDE VSCode extension and executed with
the managed venv's Python: ``python -m pyneide_bridge ...`` with PYTHONPATH
pointing at this directory's parent.
"""

# v2: additive plotMeta/colors events (pynecore viz metadata).
# v3: additive drawings events (line/label/box/table/polyline/linefill
# journal). The client tolerates unknown events, so older consumers keep
# working.
PROTOCOL_VERSION = 3
