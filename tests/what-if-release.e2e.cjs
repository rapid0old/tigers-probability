const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {startStaticServer} = require('./static-server.cjs');

let BASE_URL = process.env.WHAT_IF_E2E_URL;
const STORE_KEY = 'tigersProbability.whatIf.store.v1';
const PRESERVED_KEYS = ['tigersGameStateV1', 'tigersObservedLearningV1', 'tigersLeagueSimulatorOverridesV1'];
const RELEASE_CACHE = 'tigers-probability-production-v4.0.1-20260923-1';

function stablePreserved(values) {
  return {...values, tigersGameStateV1: JSON.parse(values.tigersGameStateV1).state};
}

async function waitForProbability(page) {
  await page.waitForFunction(() => /^\d/.test(document.querySelector('#winBig')?.textContent || '')
    && /^\d/.test(document.querySelector('#probOut')?.textContent || ''));
}

async function openLeague(page) {
  await page.evaluate(() => {
    document.querySelector('#leagueIterations').value = '10000';
    document.querySelector('#leagueRandomSeed').value = 'v4-release-smoke';
  });
  await page.click('#leagueSimulatorTab');
  try {
    await page.waitForFunction(() => document.querySelector('#leagueRunStatus')?.textContent.includes('10,000回'));
  } catch (error) {
    throw new Error(`League result unavailable: ${await page.locator('#leagueRunStatus').textContent()}`, {cause: error});
  }
  assert(await page.locator('#leagueSummaryBody tr').count() === 6);
  assert(await page.locator('#leagueRankBody tr').count() === 6);
}

async function chooseTigersWin(page, rowIndex) {
  const row = page.locator('.whatIfFixtureRow.tigersFixture').nth(rowIndex);
  const id = await row.locator('[data-game-id]').first().getAttribute('data-game-id');
  const homeTeamId = await page.evaluate(async gameId => {
    const {LEAGUE_SNAPSHOT_2026} = await import('./league-data-2026.mjs');
    return LEAGUE_SNAPSHOT_2026.games.find(game => game.id === gameId).homeTeamId;
  }, id);
  await row.locator(`[data-what-if-outcome="${homeTeamId === 'T' ? 'HOME_WIN' : 'AWAY_WIN'}"]`).click();
}

async function run() {
  const started = BASE_URL ? null : await startStaticServer();
  if (started) BASE_URL = started.url;
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const context = await browser.newContext({viewport: {width: 390, height: 844}, serviceWorkers: 'allow'});
  let page = await context.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  try {
    await page.goto(BASE_URL, {waitUntil: 'commit', timeout: 90000});
    await page.waitForFunction(() => document.readyState === 'complete', undefined, {timeout: 90000});
    assert.match(await page.locator('header .sub').textContent(), /v4\.0\.1/);
    await waitForProbability(page);
    assert(await page.locator('#predictionCard').isVisible());
    assert(await page.locator('#winBig').isVisible());
    if (!(await page.locator('#redoBtn').count())) {
      const details = await page.evaluate(() => ({dock: Boolean(document.querySelector('#gameDock')), scripts: [...document.scripts].map(script => script.src).filter(Boolean), ready: document.readyState}));
      throw new Error(`app shell missing: ${JSON.stringify({details, errors})}`);
    }
    await page.locator('.outBtn[data-o="1"]').click();
    assert.equal(await page.locator('#undoBtn').isDisabled(), false);
    await page.click('#undoBtn');
    assert.equal(await page.locator('#redoBtn').isDisabled(), false);
    await page.click('#redoBtn');
    await page.click('#playerSettingsDetails > summary');
    await page.click('#playerSettingsDetails details > summary');
    const lineupBefore = await page.locator('#tigersLineup select').evaluateAll(nodes => nodes.map(node => node.value));
    await page.locator('#tigersLineup [data-lineup-index="0"] .lineupMoveButton').nth(1).click();
    const lineupAfter = await page.locator('#tigersLineup select').evaluateAll(nodes => nodes.map(node => node.value));
    assert.equal(lineupAfter[0], lineupBefore[1]);
    assert.equal(lineupAfter[1], lineupBefore[0]);
    await page.locator('.gameDockTab[data-dock-panel="game"]').click();
    assert(await page.locator('#dockStartNextGame').isVisible());
    await page.click('#dockStartNextGame');
    assert(await page.locator('#nextGameConfirmDialog').isVisible());
    await page.click('#cancelNextGame');
    await page.locator('.gameDockTab[data-dock-panel="game"]').click();
    await page.waitForTimeout(150);
    assert(await page.evaluate(() => Boolean(localStorage.getItem('tigersGameStateV1'))));

    await openLeague(page);
    await page.locator('.leagueOverrideSelect').first().evaluate(select => {
      select.value = 'HOME_WIN';
      select.dispatchEvent(new Event('change', {bubbles: true}));
    });
    await page.waitForFunction(() => document.querySelector('#leagueOverrideBadge')?.textContent.includes('1試合'));
    const preserved = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), PRESERVED_KEYS);
    const normalResult = await page.locator('#leagueSummaryBody').textContent();

    await page.click('#openWhatIf');
    await page.fill('#newWhatIfName', 'v4公開前確認');
    await page.click('#createWhatIfScenario');
    await chooseTigersWin(page, 0);
    assert.match(await page.locator('#whatIfAssumptionCount').textContent(), /1試合/);
    await page.click('#runWhatIfSimulation');
    await page.waitForFunction(() => document.querySelector('#whatIfResultState')?.textContent === '再計算済み');
    await chooseTigersWin(page, 1);
    await chooseTigersWin(page, 2);
    assert.equal(await page.locator('#whatIfResultState').textContent(), '条件変更あり');
    await page.click('#whatIfAllGames');
    await page.locator('.whatIfFixtureRow:not(.tigersFixture) [data-what-if-outcome="TIE"]').first().click();
    await page.click('#runWhatIfSimulation');
    await page.waitForFunction(() => document.querySelector('#whatIfResultState')?.textContent === '再計算済み');
    assert(await page.locator('#whatIfHeadlineResults').isVisible());
    assert(await page.locator('#whatIfComparisonBody tr').count() > 0);
    await page.click('#saveWhatIfScenario');
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORE_KEY);
    assert.equal(saved.scenarios.length, 1);
    assert.equal(saved.base_contexts.length, 1);
    await page.click('#exitWhatIf');
    assert.equal(await page.locator('#leagueSummaryBody').textContent(), normalResult);
    assert.deepEqual(stablePreserved(await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), PRESERVED_KEYS)), stablePreserved(preserved));

    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const cached = await page.evaluate(async cacheName => {
      const cache = await caches.open(cacheName);
      return (await cache.keys()).map(request => new URL(request.url).pathname + new URL(request.url).search);
    }, RELEASE_CACHE);
    for (const asset of ['index.html', 'v10.css?v=production-v4.0.1-1', 'app-v10.js?v=production-v4.0.1-1', 'rosters.js?v=production-20260923-1', 'stats-v13.js?v=production-20260923-1', 'league-data-2026.mjs?v=production-20260923-1', 'what-if-base-context.mjs', 'what-if-scenario.mjs', 'scenario-store.mjs', 'what-if-simulator.mjs', 'league-simulator-core.mjs?v=production-v4.0.0-1', 'league-simulator-ui.mjs?v=production-20260923-1']) {
      assert(cached.some(url => url.endsWith(asset)), `PWA cache missing ${asset}`);
    }

    await page.close();
    await context.setOffline(true);
    page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(BASE_URL, {waitUntil: 'commit', timeout: 90000});
    await page.waitForFunction(() => document.readyState === 'complete', undefined, {timeout: 90000});
    assert.match(await page.locator('header .sub').textContent(), /v4\.0\.1/);
    await waitForProbability(page);
    await openLeague(page);
    await page.click('#openWhatIf');
    await page.locator(`[data-scenario-id="${saved.scenarios[0].scenario_id}"] [data-saved-action="open"]`).click();
    assert.equal(await page.inputValue('#whatIfScenarioName'), 'v4公開前確認');
    await page.locator('.whatIfFixtureRow.tigersFixture').first().locator('[data-what-if-outcome="TIE"]').click();
    assert.match(await page.locator('#whatIfAssumptionCount').textContent(), /条件変更/);
    await page.click('#runWhatIfSimulation');
    await page.waitForFunction(() => document.querySelector('#whatIfResultState')?.textContent === '再計算済み');
    await page.click('#saveWhatIfScenario');
    await page.click('#manageWhatIfScenarios');
    page.once('dialog', dialog => dialog.accept('v4確認済み'));
    await page.locator(`[data-scenario-id="${saved.scenarios[0].scenario_id}"] [data-saved-action="rename"]`).click();
    assert.equal(await page.inputValue('#whatIfScenarioName'), 'v4確認済み');
    await page.click('#closeWhatIfDialog');
    await page.click('#exitWhatIf');
    await page.click('#openWhatIf');
    page.once('dialog', dialog => dialog.accept());
    await page.locator(`[data-scenario-id="${saved.scenarios[0].scenario_id}"] [data-saved-action="delete"]`).click();
    assert.equal((await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORE_KEY)).scenarios.length, 0);
    await page.click('#closeWhatIfDialog');
    assert(await page.locator('#leagueNormalContent').isVisible());
    assert.deepEqual(stablePreserved(await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), PRESERVED_KEYS)), stablePreserved(preserved));
    assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ok: true, offlineReload: true, cachedAssets: cached.length, normalSmoke: true, whatIfSmoke: true, preservedKeys: PRESERVED_KEYS}) + '\n');
  } finally {
    await context.close();
    await browser.close();
    if (started) await new Promise(resolve => started.server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
