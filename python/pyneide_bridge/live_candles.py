"""
@pyne

The script of a live chart without a script (``--live`` with ``--data-only``):
it draws nothing, so the run streams the provider's candles only.
"""
from pynecore.lib import script


@script.indicator("Live candles", overlay=True)
def main():
    pass
