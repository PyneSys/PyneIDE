"""
@pyne edge

This code was compiled by PyneComp v6.0.80 — the Pine Script to Python compiler.
Run with open-source PyneCore: https://pynecore.org
Compile Pine Scripts online at PyneSys: https://pynesys.io
"""
from pynecore.lib import close, color, input, plot, script, strategy, ta


@script.strategy("Pyne Demo: RSI Strategy", overlay=False, initial_capital=10000)
def main(
    rsiLength=input.int(14, "RSI Length", minval=1),
    entryLevel=input.float(30.0, "Entry Level"),
    exitLevel=input.float(70.0, "Exit Level")
):
    rsiValue = ta.rsi(close, rsiLength)

    if ta.crossover(rsiValue, entryLevel):
        strategy.entry('Long', strategy.long)

    if ta.crossunder(rsiValue, exitLevel):
        strategy.close('Long')

    plot(rsiValue, title='RSI', color=color.purple)
    plot(entryLevel, title='Entry Level', color=color.green)
    plot(exitLevel, title='Exit Level', color=color.red)


if __name__ == "__main__":
    from pynecore.standalone import run
    run(__file__)
