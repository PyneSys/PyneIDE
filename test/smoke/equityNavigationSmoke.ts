import assert from 'node:assert/strict';
import type { TradeRecord } from '../../src/run/bridgeClient';
import { calculateEquitySummary, equityPointAtX } from '../../src/chart/webview/equityCurve';
import { tradeAtTimestamp } from '../../src/chart/webview/tradeNavigation';

const points = calculateEquitySummary([
  { timestamp: 100, equity: 1000 },
  { timestamp: 120, equity: null },
  { timestamp: 200, equity: 980 },
  { timestamp: 1000, equity: 1040 },
], 1000)!.points;
assert.equal(equityPointAtX([], 10, 900), undefined);
assert.equal(equityPointAtX(points, -10, 900), points[0]);
assert.equal(equityPointAtX(points, 110, 900), points[1]);
assert.equal(equityPointAtX(points, 450, 900), points[1]);
assert.equal(equityPointAtX(points, 511, 900), points[2]);
assert.equal(equityPointAtX(points, 10000, 900), points[2]);
assert.equal(equityPointAtX([points[1]], 300, 900), points[1]);

const dense = Array.from({ length: 100000 }, (_, i) => ({ timestamp: i, equity: i, pnl: i }));
assert.equal(equityPointAtX(dense, 510, 1000), dense[49999]);

function trade(entryTime: number, exitTime: number): TradeRecord {
  return {
    entryId: 'entry', entryBar: 0, entryTime, entryPrice: 10, entryComment: null,
    exitId: 'exit', exitBar: 0, exitTime, exitPrice: 11, exitComment: null,
    size: 1, commission: 0, profit: 1, profitPct: 10, cumProfit: 1, cumProfitPct: 10,
  };
}

const trades = [trade(100, 200), trade(400, 500), trade(700, 0)];
assert.equal(tradeAtTimestamp([], 150), undefined);
assert.equal(tradeAtTimestamp(trades, 50), 0);
assert.equal(tradeAtTimestamp(trades, 180), 0);
assert.equal(tradeAtTimestamp(trades, 200), 0);
assert.equal(tradeAtTimestamp(trades, 260), 0);
assert.equal(tradeAtTimestamp(trades, 350), 1);
assert.equal(tradeAtTimestamp(trades, 450), 1);
assert.equal(tradeAtTimestamp(trades, 900), 2);
assert.equal(tradeAtTimestamp([trades[2], trades[1], trades[0]], 450), 1);
assert.equal(tradeAtTimestamp([trade(200, 300), trade(100, 200)], 200), 1);
assert.equal(tradeAtTimestamp([trade(100, 800), trade(300, 500)], 450), 1);
assert.equal(tradeAtTimestamp([trade(0, 0), trade(NaN, 0)], 100), undefined);

console.log('equity cursor and trade navigation smoke passed');
