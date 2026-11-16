// The Operator sheet, end to end: one shift on one press, from the first tap
// to the supervisor's unlock, on the demo backend in a real browser.
//
// Each step checks what the floor would see. With E2E_RECORD=<file> the
// sheet's markup after every step is written out; with E2E_COMPARE=<file> it
// is compared against such a recording — the check for a change that is meant
// to move code and nothing else.
import { readFileSync, writeFileSync } from 'node:fs';
import { SUPERVISOR_PASSWORD, checker, openPage, startApp } from './harness.mjs';

const PRESS = '850T';
const check = checker();
const snapshots = {};

const app = await startApp();
const { browser, page, errors } = await openPage(app.url, `#/op/${PRESS}`);

/** What the sheet shows, in the terms the checks below are written in. */
const sheet = () =>
  page.evaluate(() => {
    const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const toastEl = document.getElementById('toast');
    const modalOpen = document.getElementById('modal').classList.contains('open');
    const value = (name) => document.querySelector(`[data-meta="${name}"]`)?.value ?? null;
    return {
      toast: toastEl.className.includes('show') ? toastEl.textContent : null,
      modalTitle: modalOpen ? text(document.querySelector('#mc .bd-title, #mc h2')) : null,
      status: [...document.querySelectorAll('[data-row="status"]')].map((b) => text(b)).join(''),
      qc: [...document.querySelectorAll('[data-qc-slot]')].map((b) => text(b)),
      banners: [...document.querySelectorAll('.op-sheet > div')].map((d) => d.className.split(' ')[0]),
      machine: value('machine'),
      job: value('job'),
      operator: value('operator'),
      supervisor: value('supervisor'),
      side: text(document.querySelector('.op-side')),
      shiftOn: text(document.querySelector('[data-shift].on, [data-shift].is-on, [data-shift][aria-pressed="true"]')),
    };
  });

/** Let the page settle, record its markup under `name`, and return the sheet. */
let current = 'start';
async function step(name, action) {
  current = name;
  await action();
  await page.waitForTimeout(300);
  snapshots[name] = await page.evaluate(() => ({
    app: document.getElementById('app').innerHTML,
    modal: document.getElementById('modal').classList.contains('open')
      ? document.getElementById('mc').innerHTML
      : null,
    toast: document.getElementById('toast').className.includes('show')
      ? document.getElementById('toast').textContent
      : null,
  }));
  return sheet();
}

const tapSlot = (slot) => page.click(`[data-row="status"][data-slot="${slot}"]`);

try {
  await page.waitForSelector('.op-sheet');

  // --- the sheet opens on the press's running order ------------------------
  let s = await step('open', async () => {});
  check.equal(s.machine, PRESS, 'opens on the press in the address');
  check.ok(!!s.job, 'opens on the order running on the press');
  check.equal(s.status.length, 16, 'draws sixteen half-hours');
  check.equal(s.status, 'RRRRRRR·········', 'shows the shift so far');
  check.ok(!s.banners.includes('lock-banner'), 'an order in progress is not locked');
  const job = s.job;

  // --- Machine Status -------------------------------------------------------
  s = await step('status picker', () => tapSlot(7));
  check.ok(/^Set status — slot 8\/16 \(10:30–11:00\)/.test(s.modalTitle ?? ''), 'a tap on a slot asks for its status');

  s = await step('running', () => page.click('#mc [data-pick="R"]'));
  check.equal(s.status, 'RRRRRRRR········', 'Running fills the slot');
  check.equal(s.toast, 'Filled 1 slot with R', 'and says so');

  s = await step('breakdown category', async () => {
    await tapSlot(8);
    await page.click('#mc [data-pick="B"]');
  });
  check.ok(/Report breakdown/.test(s.modalTitle ?? ''), 'a breakdown asks for its category first');
  check.equal(s.status, 'RRRRRRRR········', 'and is not recorded before it has a cause');

  s = await step('breakdown cause list', () => page.click('#mc [data-cat="ELE"]'));
  check.ok(/Electrical/.test(s.modalTitle ?? ''), 'then for the cause within it');

  s = await step('breakdown recorded', () => page.click('#mc [data-code="ELE-03"]'));
  check.equal(s.status, 'RRRRRRRRB·······', 'the breakdown is on the timeline');
  check.equal(s.modalTitle, null, 'and the dialog has closed');

  // --- rejects --------------------------------------------------------------
  const rejectBefore = /Total Reject(\d+)/.exec(s.side)?.[1];
  s = await step('reject entered', async () => {
    const cell = page.locator('input[data-row="named"][data-code="D01"][data-slot="2"]');
    await cell.fill('3');
    await cell.dispatchEvent('change');
  });
  const rejectAfter = /Total Reject(\d+)/.exec(s.side)?.[1];
  check.equal(Number(rejectAfter), Number(rejectBefore) + 3, 'a reject entered in a half-hour adds to Total Reject');

  // --- Quality Checks -------------------------------------------------------
  s = await step('qc picker (operator)', () => page.click('[data-qc-slot="0"]'));
  check.ok(/Quality Check — slot 1\/16/.test(s.modalTitle ?? ''), 'a Quality Check asks who signs');
  const operatorNames = await page.$$eval('#mc [data-qc-pick]', (els) => els.map((e) => e.dataset.qcPick));
  s = await step('qc signed (operator)', () => page.click('#mc [data-qc-pick="Tony Lee"]'));
  check.equal(s.qc[0], '✓ TL', 'and shows their initials');

  s = await step('qc picker (supervisor)', () => page.click('[data-qc-slot="1"]'));
  const supervisorNames = await page.$$eval('#mc [data-qc-pick]', (els) => els.map((e) => e.dataset.qcPick));
  check.ok(
    supervisorNames.includes('Jeff Penn') && !supervisorNames.includes('Tony Lee'),
    "the supervisor's check (slot 2) is signed from the supervisors, not the operators",
  );
  check.ok(operatorNames.includes('Tony Lee'), "an operator's check is signed from the operators");
  s = await step('qc signed (supervisor)', () => page.click('#mc [data-qc-pick="Jeff Penn"]'));
  check.equal(s.qc[1], '✓ JP', "the supervisor's initials are on their check");

  // --- sign-off gates -------------------------------------------------------
  s = await step('sign-off without a supervisor', () => page.click('[data-saveclear]'));
  check.equal(s.toast, 'Pick a Supervisor before signing off', 'sign-off needs a Supervisor');
  check.equal(s.modalTitle, null, 'and opens nothing without one');

  s = await step('supervisor picked', () => page.selectOption('[data-meta="supervisor"]', 'Jeff Penn'));
  check.equal(s.supervisor, 'Jeff Penn', 'the Supervisor is picked from the list');

  s = await step('sign-off over the output limit', () => page.click('[data-saveclear]'));
  check.ok(/above 130% of Shift Target/.test(s.toast ?? ''), 'output above 130% of the Shift Target stops the sign-off');
  check.equal(s.modalTitle, null, 'and opens nothing');

  s = await step('count end corrected', async () => {
    await page.fill('[data-meta="cend"]', '150');
    await page.dispatchEvent('[data-meta="cend"]', 'change');
  });
  check.ok(!/above 130%/.test(s.side), 'a Count End within the limit clears the warning');

  // --- sign-off ---------------------------------------------------------------
  s = await step('sign-off dialog', () => page.click('[data-saveclear]'));
  check.ok(/Sign off/.test(s.modalTitle ?? ''), 'the sign-off dialog shows the figures to confirm');
  check.equal(
    await page.textContent('#mc [data-confirm-save]'),
    'Sign off as Jeff Penn',
    'and names who is signing',
  );

  s = await step('signed off', () => page.click('#mc [data-confirm-save]'));
  check.ok(/^Signed off · /.test(s.toast ?? ''), 'signing off says the order was saved');
  check.ok(s.banners.includes('lock-banner'), 'and the sheet is locked');

  s = await step('edit refused when locked', () => tapSlot(9));
  check.ok(/^Signed off/.test(s.toast ?? ''), 'a locked sheet refuses an edit');
  check.equal(s.modalTitle, null, 'and opens no picker');

  // --- the supervisor unlocks it ----------------------------------------------
  check.equal(await page.locator('[data-unlock]').count(), 0, 'nobody but a supervisor is offered Unlock');
  check.ok(/Supervisor sign-in required/.test(await page.textContent('.lock-banner')), 'and the banner says who can');

  await step('supervisor sign-in', async () => {
    await page.click('[data-supervisor]');
    await page.fill('#mc [data-pwd]', SUPERVISOR_PASSWORD);
    await page.click('#mc [data-mod="ok"]');
  });
  s = await step('unlock dialog', () => page.click('[data-unlock]'));
  check.ok(/Unlock/.test(s.modalTitle ?? ''), 'a signed-in supervisor is asked to confirm the unlock');
  s = await step('unlocked', () => page.click('#mc [data-mod="confirm"]'));
  check.ok(!s.banners.includes('lock-banner'), 'unlocking lifts the lock');
  check.ok(s.banners.includes('reopened-banner'), 'and marks the sheet reopened for correction');
  check.equal(s.job, job, 'on the same order');
  check.equal(s.status, 'RRRRRRRRB·······', 'with what was signed still on it');

  // --- moving about -------------------------------------------------------------
  s = await step('next shift', () => page.click('[data-shift="Afternoon"]'));
  check.ok(s.banners.includes('future-banner'), 'a shift that has not started says so');
  s = await step('back to the running shift', () => page.click('[data-shift="Day"]'));
  check.equal(s.status, 'RRRRRRRRB·······', 'coming back shows the shift as it was left');

  s = await step('another press', () => page.selectOption('[data-meta="machine"]', '320T'));
  check.equal(s.machine, '320T', 'the Machine list moves the sheet to another press');
  check.ok(s.status !== 'RRRRRRRRB·······', 'which has its own timeline');

  check.equal(errors, [], 'the page raised no errors');
} catch (e) {
  check.failures.push(`the run stopped at "${current}": ${String(e).split('\n')[0]}`);
} finally {
  await browser.close();
  app.stop();
}

if (process.env.E2E_RECORD) {
  writeFileSync(process.env.E2E_RECORD, JSON.stringify(snapshots, null, 1));
  console.log(`recorded ${Object.keys(snapshots).length} steps to ${process.env.E2E_RECORD}`);
}
if (process.env.E2E_COMPARE) {
  const before = JSON.parse(readFileSync(process.env.E2E_COMPARE, 'utf8'));
  for (const name of new Set([...Object.keys(before), ...Object.keys(snapshots)])) {
    check.ok(
      JSON.stringify(before[name]) === JSON.stringify(snapshots[name]),
      `step "${name}" draws the same markup as the recording`,
    );
  }
}

if (check.failures.length) {
  console.error(`operator sheet: ${check.failures.length} of ${check.count} checks failed`);
  for (const failure of check.failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log(`operator sheet: ${check.count} checks passed`);
