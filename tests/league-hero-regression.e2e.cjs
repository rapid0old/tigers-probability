const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {startStaticServer} = require('./static-server.cjs');

async function run() {
  const {server, url} = await startStaticServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  });
  try {
    for (const [width, height] of [[390, 844], [390, 667], [390, 520], [393, 852], [375, 812]]) {
      const context = await browser.newContext({viewport: {width, height}, isMobile: true, hasTouch: true});
      const page = await context.newPage();
      try {
        await page.goto(url, {waitUntil: 'load'});
        await page.evaluate(() => { document.querySelector('#leagueIterations').value = '10000'; });
        await page.click('#leagueSimulatorTab');
        await page.waitForFunction(() => document.querySelector('#leagueSummaryBody tr')?.textContent);
        const geometry = await page.evaluate(() => {
          const rect = selector => document.querySelector(selector).getBoundingClientRect();
          return {
            viewport: document.documentElement.clientWidth,
            document: document.documentElement.scrollWidth,
            hero: rect('.leagueHero').width,
            title: rect('.leagueHero > div:first-child').width,
            description: rect('.leagueHero p').width,
            headingHeight: rect('.leagueHero h2').height,
            action: rect('.leagueHeroActions').width
          };
        });
        console.log(`${width}x${height}: ${JSON.stringify(geometry)}`);
        if (process.env.MEASURE_ONLY !== '1') {
          assert(geometry.title >= geometry.hero * 0.75, 'League title column collapsed');
          assert(geometry.description >= geometry.hero * 0.70, 'League description column collapsed');
          assert(geometry.headingHeight < 60, 'League heading wrapped vertically');
          assert(geometry.document <= geometry.viewport, 'Horizontal page scroll');
        }
        assert(await page.locator('#openWhatIf').isVisible());
        assert.equal(await page.locator('#leagueSummaryBody tr').count(), 6);
        assert.equal(await page.locator('#leagueRankBody tr').count(), 6);
        await page.click('#pacificLeagueTab');
        assert.equal(await page.locator('#leagueSummaryBody tr').count(), 6);
        await page.click('#centralLeagueTab');
        await page.click('#runLeagueSimulation');
        await page.waitForFunction(() => document.querySelector('#leagueRunStatus')?.textContent.includes('10,000回'));
        await page.click('#openWhatIf');
        assert(await page.locator('#whatIfStartDialog').isVisible());
        await page.click('#closeWhatIfDialog');
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
