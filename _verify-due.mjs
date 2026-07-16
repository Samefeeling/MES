import { chromium } from 'playwright';

const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  hasTouch: true,
  viewport: { width: 1024, height: 768 },
});
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text()));

await page.goto('http://localhost:5199/#/trace', { waitUntil: 'networkidle' });
// Switch to Die Management tab
await page.click('[data-tab="die"]');
await page.waitForSelector('[data-die-detail="DIE-3597"]', { timeout: 10000 });
// Open the drilldown for the overdue die
await page.click('[data-die-detail="DIE-3597"]');
await page.waitForSelector('#mc .die-detail', { timeout: 8000 });

// Grab the Maintenance Track section text (woRow output)
const histText = await page.$$eval('#mc .die-hist-row', (rows) =>
  rows.map((r) => r.innerText.replace(/\s+/g, ' ').trim()),
);
const dueEls = await page.$$eval('#mc .die-hist-due', (els) =>
  els.map((e) => ({ text: e.innerText.trim(), overdue: e.classList.contains('overdue') })),
);

console.log('=== Maintenance Track rows ===');
histText.forEach((t) => console.log(' •', t));
console.log('=== die-hist-due elements ===');
dueEls.forEach((d) => console.log('  ', JSON.stringify(d)));

await page.screenshot({ path: '/tmp/claude-0/-home-user-MES/55a5cfb4-04ac-5161-b50d-2303ed13ad28/scratchpad/due.png', fullPage: false });
// Also capture just the modal
const modal = await page.$('#mc');
if (modal) await modal.screenshot({ path: '/tmp/claude-0/-home-user-MES/55a5cfb4-04ac-5161-b50d-2303ed13ad28/scratchpad/due-modal.png' });

await browser.close();
