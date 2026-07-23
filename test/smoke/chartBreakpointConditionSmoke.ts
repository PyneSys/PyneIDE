import {
  addChartTimestamp,
  pureChartBreakpointTimestamps,
  removeChartTimestamp,
  splitChartCondition,
} from '../../src/debug/chartBreakpointCondition';

function equal(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`Expected ${right}, got ${left}`);
}

equal(addChartTimestamp(undefined, 200), '(time == 200)');
equal(addChartTimestamp('(time == 200)', 100), '(time in (100, 200))');
equal(addChartTimestamp('(time in (100, 200))', 200), '(time in (100, 200))');
equal(
  addChartTimestamp('close > basis', 200),
  '(close > basis) and (time == 200)'
);
equal(
  removeChartTimestamp('(close > basis) and (time in (100, 200))', 100),
  '(close > basis) and (time == 200)'
);
equal(
  removeChartTimestamp('(close > basis) and (time == 200)', 200),
  'close > basis'
);
equal(removeChartTimestamp('(time == 200)', 200), undefined);
equal(splitChartCondition('time == 123'), { timestamps: [123] });
equal(splitChartCondition('user_managed_weirdness'), {
  base: 'user_managed_weirdness',
  timestamps: [],
});
equal(pureChartBreakpointTimestamps('(time in (100, 200))'), [100, 200]);
equal(pureChartBreakpointTimestamps('(close > basis) and (time == 200)'), undefined);
equal(pureChartBreakpointTimestamps('close > basis'), undefined);

let invalidTimestampRejected = false;
try {
  addChartTimestamp(undefined, -1);
} catch (error) {
  invalidTimestampRejected = error instanceof RangeError;
}
equal(invalidTimestampRejected, true);

console.log('chart breakpoint condition smoke passed');
