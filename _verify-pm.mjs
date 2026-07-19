import { chromium } from 'playwright';

const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  hasTouch: true,
  viewport: { width: 1100, height: 850 },
});
const page = await ctx.newPage();

await page.goto('http://localhost:5199/#/trace', { waitUntil: 'networkidle' });
await page.click('[data-tab="die"]');
await page.waitForSelector('[data-die-detail="DIE-3597"]', { timeout: 10000 });

// 1. CUSTOM plan die (DIE-3597 seeded with custom MaintenanceLevel)
await page.click('[data-die-detail="DIE-3597"]');
await page.waitForSelector('#mc .die-pm-plan', { timeout: 8000 });
const custom = await page.$eval('#mc .die-pm-plan', (el) => el.innerText.replace(/\s+/g, ' ').slice(0, 400));
const customSrc = await page.$eval('#mc .die-pm-src', (el) => el.innerText);
console.log('DIE-3597 src chip:', JSON.stringify(customSrc));
console.log('DIE-3597 plan:', custom);
const editBtnBefore = await page.$('#mc [data-die-pm]');
console.log('edit button WITHOUT supervisor:', editBtnBefore ? 'VISIBLE (bug)' : 'hidden ✓');
await page.click('#mc [data-mod="close"]');

// 2. DEFAULT plan die (DIE-1422 has no custom text)
await page.click('[data-die-detail="DIE-1422"]');
await page.waitForSelector('#mc .die-pm-plan', { timeout: 8000 });
const dflt = await page.$eval('#mc .die-pm-plan', (el) => el.innerText.replace(/\s+/g, ' ').slice(0, 300));
const dfltSrc = await page.$eval('#mc .die-pm-src', (el) => el.innerText);
console.log('DIE-1422 src chip:', JSON.stringify(dfltSrc));
console.log('DIE-1422 plan:', dflt);
await page.click('#mc [data-mod="close"]');

// 3. Supervisor ON → edit button appears; edit + save round-trip
await page.evaluate(() => sessionStorage.setItem('pmd_supervisor_mode', '1'));
await page.click('[data-die-detail="DIE-1422"]');
await page.waitForSelector('#mc .die-pm-plan', { timeout: 8000 });
const editBtn = await page.$('#mc [data-die-pm]');
console.log('edit button WITH supervisor:', editBtn ? 'visible ✓' : 'MISSING (bug)');
if (editBtn) {
  await editBtn.click();
  await page.waitForSelector('#mc .die-pm-text', { timeout: 5000 });
  await page.fill('#mc .die-pm-text', 'L1 | every die change | Custom wipe test\nL2 | 9,000 shots | Custom bench test');
  await page.click('#mc [data-pm-save]');
  await page.waitForSelector('#mc .die-pm-plan', { timeout: 5000 });
  const after = await page.$eval('#mc .die-pm-plan', (el) => el.innerText.replace(/\s+/g, ' ').slice(0, 220));
  console.log('after save:', after);
}
const modal = await page.$('#mc');
if (modal) await modal.screenshot({ path: '/tmp/claude-0/-home-user-MES/55a5cfb4-04ac-5161-b50d-2303ed13ad28/scratchpad/pm-plan.png' });
await browser.close();
