"""
@pyne edge

This code was compiled by PyneComp v6.0.80 — the Pine Script to Python compiler.
Run with open-source PyneCore: https://pynecore.org
Compile Pine Scripts online at PyneSys: https://pynesys.io
"""
from pynecore.lib import close, color, input, location, plot, plotshape, script, shape, size, ta


@script.indicator("Pyne Demo: SMA Cross", overlay=True)
def main(
    fastLength=input.int(9, "Fast Length", minval=1),
    slowLength=input.int(21, "Slow Length", minval=1)
):
    fast = ta.sma(close, fastLength)
    slow = ta.sma(close, slowLength)

    plot(fast, color=color.teal, title='Fast SMA')
    plot(slow, color=color.orange, title='Slow SMA')
    plotshape(ta.crossover(fast, slow), title='Bullish Cross', style=shape.triangleup, location=location.belowbar, color=color.green, size=size.small)
    plotshape(ta.crossunder(fast, slow), title='Bearish Cross', style=shape.triangledown, location=location.abovebar, color=color.red, size=size.small)


if __name__ == "__main__":
    from pynecore.standalone import run
    run(__file__)
