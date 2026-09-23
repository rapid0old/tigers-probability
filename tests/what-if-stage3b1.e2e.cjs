const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const BASE_URL = process.env.WHAT_IF_E2E_URL || 'http://127.0.0.1:8765/';
const STORE_KEY = 'tigersProbability.whatIf.store.v1';
const NORMAL_KEY = 'tigersLeagueSimulatorOverridesV1';
const LEARNING_KEY = 'tigersObservedLearningV1';

async function openLeague(page) {
  await page.goto(BASE_URL, {waitUntil: 'networkidle'});
  await page.evaluate(() => {
    document.querySelector('#leagueIterations').value = '10000';
    document.querySelector('#leagueRandomSeed').value = 'stage3b1-test';
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

async function activeScenarioId(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)).scenarios.at(-1)?.scenario_id, STORE_KEY);
}

async function patchStoreWrites(page) {
  await page.evaluate(key => {
    window.__whatIfOriginalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (storageKey, value) {
      if (storageKey === key) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return window.__whatIfOriginalSetItem.call(this, storageKey, value);
    };
  }, STORE_KEY);
}

async function restoreStoreWrites(page) {
  await page.evaluate(() => {
    if (window.__whatIfOriginalSetItem) Storage.prototype.setItem = window.__whatIfOriginalSetItem;
    delete window.__whatIfOriginalSetItem;
  });
}

async function runAuditFlow(browser) {
  const context = await browser.newContext({viewport: {width: 390, height: 844}, serviceWorkers: 'block'});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE_URL, {waitUntil: 'networkidle'});
  const normalFixtureId = await page.evaluate(async () => {
    const {LEAGUE_SNAPSHOT_2026} = await import('./league-data-2026.mjs');
    return LEAGUE_SNAPSHOT_2026.games.find(game => game.status !== 'FINAL').id;
  });
  await page.evaluate(({normalFixtureId}) => {
    localStorage.clear();
    localStorage.setItem('tigersLeagueSimulatorOverridesV1', JSON.stringify({schemaVersion: 1, snapshotThrough: '2026-09-17', entries: {[normalFixtureId]: {result: 'HOME_WIN'}}}));
    localStorage.setItem('tigersObservedLearningV1', JSON.stringify({version: 1, baselineKey: 'audit', enabled: true, capture: true, entries: [], steals: []}));
  }, {normalFixtureId});
  await openLeague(page);
  const normalBefore = await page.evaluate(key => localStorage.getItem(key), NORMAL_KEY);
  const learningBefore = await page.evaluate(key => localStorage.getItem(key), LEARNING_KEY);
  const normalResultBefore = await page.locator('#leagueSummaryBody').textContent();

  await createScenario(page, '監査Scenario A');
  await page.click('#saveWhatIfScenario');
  const scenarioA = await activeScenarioId(page);
  const firstRow = page.locator('.whatIfFixtureRow.tigersFixture').first();
  await firstRow.locator('[data-what-if-outcome="HOME_WIN"]').click();
  await page.click('#runWhatIfSimulation');
  await page.waitForFunction(() => document.querySelector('#whatIfResultState')?.textContent === '再計算済み');
  await page.click('#saveWhatIfScenario');
  const calculatedHtml = await page.locator('#whatIfComparison').innerHTML();

  await page.click('#manageWhatIfScenarios');
  page.once('dialog', dialog => dialog.accept('名前変更のみ'));
  await page.locator(`[data-scenario-id="${scenarioA}"] [data-saved-action="rename"]`).click();
  assert(await firstRow.locator('[data-what-if-outcome="HOME_WIN"]').evaluate(node => node.classList.contains('active')), '1. 名前変更後も試合指定を保持');
  assert.equal(await page.locator('#whatIfResultState').textContent(), '再計算済み', '2. 名前だけの変更は計算結果と整合');
  assert.equal(await page.locator('#whatIfComparison').innerHTML(), calculatedHtml);
  await page.click('#closeWhatIfDialog');

  await firstRow.locator('[data-what-if-outcome="TIE"]').click();
  assert.equal(await page.locator('#whatIfResultState').textContent(), '条件変更あり', '8. game override変更で再計算要求');
  await page.click('#manageWhatIfScenarios');
  page.once('dialog', dialog => dialog.accept('draftを保持する名前'));
  await page.locator(`[data-scenario-id="${scenarioA}"] [data-saved-action="rename"]`).click();
  assert(await firstRow.locator('[data-what-if-outcome="TIE"]').evaluate(node => node.classList.contains('active')), '1. 未保存指定を名前変更で失わない');
  assert.match(await page.locator('#whatIfBaseMeta').textContent(), /未保存/);

  await page.fill('#newWhatIfName', '破棄確認Scenario');
  page.once('dialog', dialog => dialog.dismiss());
  await page.click('#createWhatIfScenario');
  assert.equal(await page.inputValue('#whatIfScenarioName'), 'draftを保持する名前', '3-4. 新規作成確認をキャンセルすると元Scenario維持');
  assert(await firstRow.locator('[data-what-if-outcome="TIE"]').evaluate(node => node.classList.contains('active')));
  page.once('dialog', dialog => dialog.accept());
  await page.click('#createWhatIfScenario');
  assert.equal(await page.inputValue('#whatIfScenarioName'), '破棄確認Scenario', '5. 確認後に新規Scenario作成');
  await page.click('#saveWhatIfScenario');
  const scenarioB = await activeScenarioId(page);

  const rowB = page.locator('.whatIfFixtureRow.tigersFixture').first();
  await rowB.locator('[data-what-if-outcome="AWAY_WIN"]').click();
  await page.click('#manageWhatIfScenarios');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator(`[data-scenario-id="${scenarioB}"] [data-saved-action="open"]`).click();
  assert(await rowB.locator('[data-what-if-outcome="AWAY_WIN"]').evaluate(node => node.classList.contains('active')), '6-7. 同Scenario再読込確認をキャンセルすると編集維持');
  page.once('dialog', dialog => dialog.accept());
  await page.locator(`[data-scenario-id="${scenarioB}"] [data-saved-action="open"]`).click();
  assert(await page.locator('#whatIfComparison').isHidden());

  await page.click('#whatIfAllGames');
  const unknownButton = page.locator(`[data-game-id="${normalFixtureId}"][data-what-if-outcome="UNKNOWN"]`);
  await unknownButton.evaluate(node => { node.closest('details').open = true; });
  await unknownButton.click();
  assert.match(await page.locator('#whatIfAssumptionCount').textContent(), /仮定：0試合・条件変更：1件/, '15. 明示UNKNOWNを条件変更として表示');
  await page.click('#runWhatIfSimulation');
  await page.waitForFunction(() => document.querySelector('#whatIfResultState')?.textContent === '再計算済み');
  assert.equal(await page.locator('#whatIfResultState').textContent(), '再計算済み', '9. 再計算後はcalculatedへ戻る');

  await page.click('#saveWhatIfScenario');
  const savedRaw = await page.evaluate(key => localStorage.getItem(key), STORE_KEY);
  await page.locator(`[data-game-id="${normalFixtureId}"][data-what-if-outcome="TIE"]`).click();
  await patchStoreWrites(page);
  await page.click('#saveWhatIfScenario');
  assert.match(await page.locator('#whatIfRunStatus').textContent(), /保存できませんでした/, '10. 保存失敗をUI通知');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), STORE_KEY), savedRaw, '保存失敗時に既存内容不変');
  await restoreStoreWrites(page);

  await page.click('#manageWhatIfScenarios');
  await patchStoreWrites(page);
  page.once('dialog', dialog => dialog.accept());
  await page.locator(`[data-scenario-id="${scenarioA}"] [data-saved-action="delete"]`).click();
  assert.match(await page.locator('#whatIfDialogStatus').textContent(), /削除できませんでした/, '削除失敗をUI通知');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), STORE_KEY), savedRaw, '削除失敗時に既存内容不変');
  await restoreStoreWrites(page);
  const validStore = await page.evaluate(key => localStorage.getItem(key), STORE_KEY);
  await page.evaluate(key => localStorage.setItem(key, '{broken'), STORE_KEY);
  page.once('dialog', dialog => dialog.accept());
  await page.locator(`[data-scenario-id="${scenarioA}"] [data-saved-action="open"]`).evaluate(node => node.click());
  await page.waitForFunction(() => document.querySelector('#whatIfDialogStatus')?.textContent.includes('読み込み'));
  assert.match(await page.locator('#whatIfDialogStatus').textContent(), /読み込みできません/, '11. 読込失敗をUI通知');
  await page.click('#closeWhatIfDialog');
  await page.click('#manageWhatIfScenarios');
  assert.match(await page.locator('#whatIfSavedList').textContent(), /破損/, '12. 破損storeを0件と区別');
  await page.evaluate(({key, value}) => localStorage.setItem(key, value), {key: STORE_KEY, value: validStore});
  await page.click('#closeWhatIfDialog');

  page.once('dialog', dialog => dialog.accept());
  await page.click('#exitWhatIf');
  await page.click('#openWhatIf');
  await page.locator(`[data-scenario-id="${scenarioB}"] [data-saved-action="open"]`).click();
  await page.click('#whatIfAllGames');
  const groups = page.locator('.whatIfFixtureGroup');
  const targetGroup = groups.nth(Math.min(1, await groups.count() - 1));
  await targetGroup.evaluate(node => { node.open = true; });
  const groupKey = await targetGroup.getAttribute('data-what-if-section');
  await targetGroup.locator('[data-what-if-outcome="HOME_WIN"]').first().click();
  assert(await page.locator(`[data-what-if-section="${groupKey}"]`).evaluate(node => node.open), '13. 月グループ開閉を維持');

  await page.click('#saveWhatIfScenario');
  await page.click('#manageWhatIfScenarios');
  await page.locator(`[data-scenario-id="${scenarioA}"] [data-saved-action="open"]`).click();
  await page.evaluate(scenarioBId => {
    document.querySelector('#runWhatIfSimulation').click();
    document.querySelector('#manageWhatIfScenarios').click();
    document.querySelector(`[data-scenario-id="${scenarioBId}"] [data-saved-action="open"]`).click();
  }, scenarioB);
  await page.waitForTimeout(100);
  assert.equal(await page.inputValue('#whatIfScenarioName'), '破棄確認Scenario');
  assert(await page.locator('#whatIfComparison').isHidden(), '14. 切替前の計算結果を別Scenarioへ入れない');

  assert.equal(await page.evaluate(key => localStorage.getItem(key), NORMAL_KEY), normalBefore, '16. 通常override不変');
  assert.equal(await page.locator('#leagueSummaryBody').textContent(), normalResultBefore, '17. 通常Simulator結果不変');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), LEARNING_KEY), learningBefore, '18. 観戦学習不変');
  await page.click('#exitWhatIf');
  assert(await page.locator('#leagueNormalContent').isVisible(), '19. 終了後に通常状態へ復帰');

  await page.click('#openWhatIf');
  page.once('dialog', dialog => dialog.accept());
  await page.locator(`[data-scenario-id="${scenarioA}"] [data-saved-action="delete"]`).click();
  const afterDelete = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORE_KEY);
  assert(!afterDelete.scenarios.some(item => item.scenario_id === scenarioA), '20. 既存Scenario削除');
  assert.deepEqual(errors, [], 'ブラウザ例外なし');
  await context.close();
}

async function verifyMobile(browser, width, height) {
  const context = await browser.newContext({viewport: {width, height}, serviceWorkers: 'block'});
  const page = await context.newPage();
  await openLeague(page);
  await createScenario(page, `${width}x${height}`);
  await page.locator('.whatIfFixtureRow.tigersFixture').first().locator('[data-what-if-outcome="HOME_WIN"]').click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.click('#exitWhatIf');
  assert(await page.locator('#whatIfView').isVisible(), `${width}x${height}: 未保存確認を操作可能`);
  await patchStoreWrites(page);
  await page.click('#saveWhatIfScenario');
  await page.locator('#whatIfRunStatus').scrollIntoViewIfNeeded();
  assert(await page.locator('#whatIfRunStatus').isVisible(), `${width}x${height}: エラー通知へ到達可能`);
  await restoreStoreWrites(page);
  await page.click('#runWhatIfSimulation');
  await page.waitForFunction(() => document.querySelector('#whatIfResultState')?.textContent === '再計算済み');
  for (const selector of ['#saveWhatIfScenario', '#manageWhatIfScenarios', '#exitWhatIf', '#runWhatIfSimulation']) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    assert(await page.locator(selector).isVisible(), `${width}x${height}: ${selector}`);
  }
  const dimensions = await page.evaluate(() => ({width: innerWidth, scrollWidth: document.documentElement.scrollWidth}));
  assert(dimensions.scrollWidth <= dimensions.width, `${width}x${height}: 横スクロールなし`);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  try {
    await runAuditFlow(browser);
    await verifyMobile(browser, 390, 844);
    await verifyMobile(browser, 390, 667);
    await verifyMobile(browser, 390, 520);
    process.stdout.write(JSON.stringify({ok: true, regressionCases: 20, mobileViewports: 3}) + '\n');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
