/** Run after npm run build. Requires Playwright (or PLAYWRIGHT_MODULE_PATH).
 * BROWSER_EXECUTABLE_PATH may select an installed Chromium for headless tests.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}),
});
const payloads = [
  '\"><img class="xss-probe" src=x onerror="window.xssExecuted=true">',
  '</span><svg class="xss-probe" onload="window.xssExecuted=true"></svg>',
  '&quot;&lt;img class=xss-probe src=x&gt;',
];

async function setup(html, bundle) {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.evaluate(() => {
    window.sent = [];
    window.acquireVsCodeApi = () => ({ postMessage: (msg) => window.sent.push(msg) });
  });
  await page.addScriptTag({ path: path.join(root, 'dist', bundle) });
  return page;
}

async function send(page, message) {
  await page.evaluate((data) => window.dispatchEvent(new MessageEvent('message', { data })), message);
}

async function assertSafe(page, label) {
  assert.equal(await page.locator('.xss-probe').count(), 0, `${label}: injected markup`);
  assert.equal(await page.evaluate(() => Boolean(window.xssExecuted)), false, `${label}: script ran`);
}

try {
  const plugins = await setup(
    '<input id="search"><button id="refresh"></button><div id="status"></div>' +
    '<div id="list"></div><div id="detail"></div>', 'plugins.js'
  );
  const baseRow = {
    id: 'demo', package: 'demo-plugin', displayName: 'Demo plugin', summary: 'A provider',
    pluginIds: ['demo'], capabilities: ['provider'], tier: 'verified',
    latestVersion: '1.2', installed: false, builtin: false, updateAvailable: false,
    inCatalogue: true, downloads30d: 42,
  };
  const model = (row) => ({
    rows: [row], catalogue: { state: 'ok' },
    env: { managed: true, ready: true, installedKnown: true },
  });
  await send(plugins, { type: 'model', model: model(baseRow) });
  await plugins.locator('.row').click();
  await send(plugins, { type: 'detail', id: 'demo', detail: {
    description: 'Use ``demo()``.\n\nSecond paragraph.',
    project_urls: [{ name: 'Docs', url: 'https://example.com/?a=1&b=2' }],
  } });
  assert.equal(await plugins.locator('#list .badge.verified').textContent(), 'verified');
  assert.match(await plugins.locator('#detail .meta').textContent(), /42/);
  assert.equal(await plugins.locator('.doc').count(), 2);
  assert.equal(await plugins.locator('.doc .mono').textContent(), 'demo()');
  await plugins.locator('#install').click();
  await plugins.locator('[data-link]').click();
  assert.deepEqual(await plugins.evaluate(() => window.sent.slice(-2)), [
    { type: 'install', id: 'demo' },
    { type: 'openLink', url: 'https://example.com/?a=1&b=2' },
  ]);
  for (const payload of payloads) {
    for (const field of ['tier', 'downloads30d', 'displayName', 'summary', 'id']) {
      const row = { ...baseRow, [field]: payload };
      await send(plugins, { type: 'model', model: model(row) });
      await plugins.locator('.row').click();
      await assertSafe(plugins, `plugin ${field}`);
      if (field === 'tier') assert.equal(await plugins.locator('#list .badge').textContent(), payload);
      if (field === 'downloads30d') assert.ok((await plugins.locator('#detail').textContent()).includes(payload));
      if (field === 'id') assert.equal(await plugins.locator('.row').getAttribute('data-row'), payload);
    }
    await send(plugins, { type: 'model', model: model(baseRow) });
    await plugins.locator('.row').click();
    await send(plugins, { type: 'detail', id: 'demo', detail: {
      description: `Literal \`\`${payload}\`\``, author: payload,
      entry_points: [{ name: payload, value: payload }],
      project_urls: [{ name: payload, url: payload }],
    } });
    await assertSafe(plugins, 'plugin details');
    assert.equal(await plugins.locator('.doc .mono').textContent(), payload);
    assert.equal(await plugins.locator('[data-link]').getAttribute('data-link'), payload);
  }

  const chart = await setup(
    '<div id="chart" style="width:800px;height:400px"></div><div id="bottom">' +
    '<button id="tab-trades"></button><button id="tab-stats"></button><div id="tab-body"></div></div>',
    'chart-webview.js'
  );
  const start = {
    e: 'start', script: 'demo.py', scriptType: 'strategy', overlay: true,
    initialCapital: 1000, syminfo: { mintick: 0.01, timezone: 'UTC' }, data: 'demo',
    range: { from: 0, to: 0, bars: 0 }, outputs: { plot: '', strat: null, trades: null },
  };
  const trade = {
    entryId: 'Buy & hold', entryTime: 1700000000000, exitTime: 1700000060000,
    entryPrice: 100.25, exitPrice: 101.25, size: 1, profit: 1, profitPct: 1, cumProfit: 1,
  };
  await send(chart, { type: 'reset', start });
  await send(chart, { type: 'trades', trades: [trade] });
  await chart.locator('#tab-trades').click();
  assert.equal(await chart.locator('tr[data-ts]').getAttribute('data-ts'), String(trade.entryTime));
  assert.ok((await chart.locator('#tab-body').textContent()).includes(trade.entryId));
  await chart.locator('tr[data-ts]').click();
  for (const payload of payloads) {
    await send(chart, { type: 'reset', start });
    await send(chart, { type: 'openTrades', trades: [{ ...trade, entryTime: payload, entryId: payload }] });
    await chart.locator('#tab-trades').click();
    await assertSafe(chart, 'trade timestamp and id');
    assert.equal(await chart.locator('tr[data-ts]').getAttribute('data-ts'), payload);
    assert.ok((await chart.locator('#tab-body').textContent()).includes(payload));
    await send(chart, { type: 'stats', stats: { [payload]: 10, Trades: payload } });
    await chart.locator('#tab-stats').click();
    await assertSafe(chart, 'stats');
  }
  console.log('Webview XSS smoke passed: plugin list/details, trades/stats, and legitimate controls.');
} finally {
  await browser.close();
}
