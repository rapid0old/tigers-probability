const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const BASE_URL = process.env.WHAT_IF_E2E_URL || 'http://127.0.0.1:8765/';
const STORE_KEY = 'tigersProbability.whatIf.store.v1';
const NORMAL_OVERRIDE_KEY = 'tigersLeagueSimulatorOverridesV1';
const LEARNING_KEY = 'tigersObservedLearningV1';

async function openLeague(page) {
  await page.goto(BASE_URL, {waitUntil: 'networkidle'});
  await page.evaluate(() => {
    document.querySelector('#leagueIterations').value = '10000';
    document.querySelector('#leagueRandomSeed').value = 'stage3a-ui-test';
  });
  await page.click('#leagueSimulatorTab');
  await page.waitForFunction(() => document.querySelector('#leagueRunStatus')?.textContent.includes('10,000回'));
}

async function createScenario(page, name) {
  await page.click('#openWhatIf');
  await page.fill('#newWhatIfName', name);
  await page.click('#createWhatIfScenario');
  await page.waitForSelector('#whatIfView:not([hidden])');
}

async function clickOutcome(page, rowIndex, outcome, {allGames = false} = {}) {
  if (allGames) await page.click('#whatIfAllGames');
  const rows = page.locator(allGames ? '.whatIfFixtureRow:not(.tigersFixture)' : '.whatIfFixtureRow.tigersFixture');
  const row = rows.nth(rowIndex);
  await row.locator(`[data-what-if-outcome="${outcome}"]`).click();
}

async function runPrimaryFlow(browser) {
  const context = await browser.newContext({viewport: {width: 390, height: 844}, serviceWorkers: 'block'});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE_URL, {waitUntil: 'networkidle'});
  const normalFixtureId = await page.evaluate(async () => {
    const {LEAGUE_SNAPSHOT_2026} = await import('./league-data-2026.mjs');
    return LEAGUE_SNAPSHOT_2026.games.find(game => game.status !== 'FINAL').id;
  });
  await page.evaluate(({normalFixtureId, normalKey, learningKey}) => {
    localStorage.clear();
    localStorage.setItem(normalKey, JSON.stringify({schemaVersion: 1, snapshotThrough: '2026-09-17', entries: {[normalFixtureId]: {result: 'HOME_WIN', setAt: '2026-09-23T00:00:00.000Z'}}}));
    localStorage.setItem(learningKey, JSON.stringify({version: 1, baselineKey: 'observed-2026-09-17-v1', startedAt: 1, enabled: true, capture: true, entries: [], steals: []}));
  }, {normalFixtureId, normalKey: NORMAL_OVERRIDE_KEY, learningKey: LEARNING_KEY});
  await openLeague(page);

  const normalOverridesBefore = await page.evaluate(key => localStorage.getItem(key), NORMAL_OVERRIDE_KEY);
  const learningBefore = await page.evaluate(key => localStorage.getItem(key), LEARNING_KEY);
  const normalResultBefore = await page.locator('#leagueSummaryBody').textContent();
  assert(await page.locator('#openWhatIf').isVisible(), '1. What-if入口');

  await createScenario(page, '阪神3連勝');
  assert(await page.locator('#whatIfModeTitle').isVisible(), '2. Scenario新規作成');
  assert.equal(await page.inputValue('#whatIfScenarioName'), '阪神3連勝');
  await page.fill('#whatIfScenarioName', '阪神優勝条件');
  await page.locator('#whatIfScenarioName').blur();
  assert.equal(await page.inputValue('#whatIfScenarioName'), '阪神優勝条件', '3. Scenario名変更');

  await clickOutcome(page, 0, 'HOME_WIN');
  assert(await page.locator('.whatIfFixtureRow.tigersFixture').first().locator('[data-what-if-outcome="HOME_WIN"]').evaluate(node => node.classList.contains('active')), '4. HOME_WIN選択');
  await clickOutcome(page, 0, 'AWAY_WIN');
  assert(await page.locator('.whatIfFixtureRow.tigersFixture').first().locator('[data-what-if-outcome="AWAY_WIN"]').evaluate(node => node.classList.contains('active')), '5. AWAY_WIN選択');
  await clickOutcome(page, 0, 'TIE');
  assert(await page.locator('.whatIfFixtureRow.tigersFixture').first().locator('[data-what-if-outcome="TIE"]').evaluate(node => node.classList.contains('active')), '6. TIE選択');
  await clickOutcome(page, 0, 'UNKNOWN');
  assert(await page.locator('.whatIfFixtureRow.tigersFixture').first().locator('[data-what-if-outcome="UNKNOWN"]').evaluate(node => node.classList.contains('active')), '7. UNKNOWNへ戻す');
  await clickOutcome(page, 0, 'CANCELED');
  assert(await page.locator('.whatIfFixtureRow.tigersFixture').first().locator('[data-what-if-outcome="CANCELED"]').evaluate(node => node.classList.contains('active')), 'CANCELED補助操作');
  await clickOutcome(page, 0, 'UNKNOWN');

  await clickOutcome(page, 0, 'HOME_WIN');
  await clickOutcome(page, 1, 'HOME_WIN');
  assert.match(await page.locator('#whatIfAssumptionCount').textContent(), /2試合/, '8. 複数試合部分入力');
  await clickOutcome(page, 0, 'TIE', {allGames: true});
  assert(await page.locator('.whatIfFixtureRow:not(.tigersFixture)').first().locator('[data-what-if-outcome="TIE"]').evaluate(node => node.classList.contains('active')), '9. 阪神以外の試合入力');
  assert(await page.locator('#whatIfComparison').isHidden(), '10. 再計算前は比較結果を更新しない');

  const started = Date.now();
  await page.click('#runWhatIfSimulation');
  await page.waitForFunction(() => document.querySelector('#whatIfResultState')?.textContent.includes('再計算済み'));
  const calculationMs = Date.now() - started;
  assert(await page.locator('#whatIfComparison').isVisible(), '11. 再計算後にscenario_result更新');
  assert.equal(await page.locator('#leagueSummaryBody').textContent(), normalResultBefore, '12. baseline結果を破壊しない');
  const comparisonText = await page.locator('#whatIfComparison').textContent();
  assert.match(comparisonText, /通常/); assert.match(comparisonText, /What-if/); assert.match(comparisonText, /差分/, '13. 比較表示');
  const example = await page.locator('#whatIfHeadlineResults').innerText();

  await page.click('#saveWhatIfScenario');
  let store = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORE_KEY);
  assert.equal(store.scenarios.length, 1, '14. Scenario保存');
  const firstId = store.scenarios[0].scenario_id;
  assert.equal(store.base_contexts.length, 1);

  await page.click('#exitWhatIf');
  await createScenario(page, '共有Base確認');
  await page.click('#saveWhatIfScenario');
  store = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORE_KEY);
  assert.equal(store.base_contexts.length, 1, '17. 同じBaseContextを重複保存しない');
  const secondId = store.scenarios.find(item => item.scenario_id !== firstId).scenario_id;

  await page.click('#manageWhatIfScenarios');
  await page.locator(`[data-scenario-id="${firstId}"] [data-saved-action="open"]`).click();
  assert.equal(await page.inputValue('#whatIfScenarioName'), '阪神優勝条件', '15. Scenario再読込');
  await page.click('#manageWhatIfScenarios');
  page.once('dialog', dialog => dialog.accept());
  await page.locator(`[data-scenario-id="${secondId}"] [data-saved-action="delete"]`).click();
  store = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORE_KEY);
  assert.equal(store.scenarios.length, 1, '16. Scenario削除');
  assert.equal(store.base_contexts.length, 1);
  await page.click('#closeWhatIfDialog');

  await clickOutcome(page, 0, 'AWAY_WIN');
  page.once('dialog', dialog => dialog.dismiss());
  await page.click('#exitWhatIf');
  assert(await page.locator('#whatIfView').isVisible(), '未保存確認で終了を中止できる');
  page.once('dialog', dialog => dialog.accept());
  await page.click('#exitWhatIf');
  assert(await page.locator('#leagueNormalContent').isVisible(), '18. What-if終了');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), NORMAL_OVERRIDE_KEY), normalOverridesBefore, '19. 通常override不変');
  assert.equal(await page.locator('#leagueSummaryBody').textContent(), normalResultBefore, '20. 通常Simulator結果不変');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), LEARNING_KEY), learningBefore, '22. 観戦学習不変');
  assert.deepEqual(errors, [], 'ブラウザ例外なし');

  await context.close();
  return {calculationMs, example: example.replace(/\s+/g, ' ').trim()};
}

async function verifyViewport(browser, width, height, label) {
  const context = await browser.newContext({viewport: {width, height}, serviceWorkers: 'block'});
  const page = await context.newPage();
  await openLeague(page);
  await createScenario(page, `画面確認 ${label}`);
  const firstRow = page.locator('.whatIfFixtureRow.tigersFixture').first();
  assert(await page.locator('#whatIfModeTitle').isVisible());
  assert(await page.locator('#whatIfScenarioName').isVisible());
  assert(await firstRow.locator('[data-what-if-outcome="HOME_WIN"]').isVisible());
  await firstRow.locator('[data-what-if-outcome="HOME_WIN"]').click();
  await page.click('#runWhatIfSimulation');
  await page.waitForFunction(() => document.querySelector('#whatIfResultState')?.textContent.includes('再計算済み'));
  for (const selector of ['#saveWhatIfScenario', '#exitWhatIf', '#runWhatIfSimulation', '#whatIfComparison']) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    assert(await page.locator(selector).isVisible(), `${label}: ${selector}へ到達可能`);
  }
  const layout = await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    dockDisplay: getComputedStyle(document.querySelector('.gameDockShell')).display,
  }));
  assert(layout.scrollWidth <= layout.innerWidth, `${label}: 横スクロールなし`);
  assert(layout.scrollHeight > height, `${label}: 縦スクロール可能`);
  assert.equal(layout.dockDisplay, 'none', `${label}: 固定試合UIと重ならない`);
  if (process.env.SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.SCREENSHOT_DIR, {recursive: true});
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({path: path.join(process.env.SCREENSHOT_DIR, `what-if-${width}x${height}.png`), fullPage: true});
  }
  await context.close();
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
  try {
    const primary = await runPrimaryFlow(browser);
    await verifyViewport(browser, 390, 844, '23. 390x844');
    await verifyViewport(browser, 390, 667, '24. 390x667');
    await verifyViewport(browser, 390, 520, '25. 390x520');
    process.stdout.write(`${JSON.stringify({ok: true, ...primary}, null, 2)}\n`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
