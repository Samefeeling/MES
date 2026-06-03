// Built-in tutorial mode: walks an operator through a complete order
// from clock-in to Sign Off & Save with a spotlight on the relevant UI
// element and a tooltip card. Auto-launches once per browser on first
// visit; always reachable from the top-nav 📘 Tutorial button. Content
// mirrors docs/TRAINING_OPERATOR.md so the two stay in sync (printable
// card for the wall, in-app tour for the screen). Designed for the
// 10-inch iPad — every gesture description is "tap" / "tap and drag",
// every navigation button is a 48-px touch target.

interface TutorialStep {
  id: string;
  title: string;
  narration: string;
  /** Optional CSS selector to spotlight. Omit for centred message cards. */
  target?: string;
  /** Extra one-liner under the narration — usually the "what to look for". */
  hint?: string;
}

export type TutorialTrack = 'operator' | 'supervisor';

const TUTORIAL_KEY = 'pmd_tutorial_seen';

const OPERATOR_STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    title: 'Welcome — one order, start to Sign Off',
    narration:
      'This walkthrough takes you through a complete order on the iPad, from clocking in to signing off the shift. It runs about three minutes. Tap Next to advance, Back to revisit a step, or Skip to leave at any time.',
    hint: 'Tap Next to start.',
  },
  {
    id: 'date-shift',
    title: 'Check the date and shift',
    narration:
      'The top bar shows today\'s date and three shift tabs — Day, Afternoon, Night. The active shift is highlighted. The arrows on either side step the date back or forward; the Now button jumps to the live shift.',
    target: '.op-actionbar',
    hint: 'Most of the time you start on the live shift — no action needed here.',
  },
  {
    id: 'machine',
    title: 'Pick your machine',
    narration:
      'Below the date row, the first field is Machine. Tap it and choose the press you are running. The page colour changes with the shift so you can tell at a glance which one you are on.',
    target: '.m-mc',
  },
  {
    id: 'job',
    title: 'Pick the Job number',
    narration:
      'Tap the Job# field. The list shows every PMD order released in Epicor, sorted by the closest start time. If the order you have just been given is not in the list yet — the sync runs every 15 minutes — type the JobNum straight in.',
    target: '.m-job',
    hint: 'Past shifts show only the jobs that actually ran, so you can review history without scrolling through hundreds of orders.',
  },
  {
    id: 'part-desc',
    title: 'Part # and Description auto-fill',
    narration:
      'Once you pick a Job#, Part# and Product Description fill themselves from the planning sync. You cannot type into them — they are read-only on purpose, so the values always match what was released in Epicor.',
    target: '.m-part',
  },
  {
    id: 'operator',
    title: 'Pick your name (Operator)',
    narration:
      'Tap the Operator field and choose your own name. It stays for the rest of the shift unless you change it. After Sign Off & Save the field becomes read-only so it cannot be touched by accident.',
    target: '.m-op',
  },
  {
    id: 'supervisor',
    title: 'Pick your supervisor',
    narration:
      'Pick the supervisor on shift with you. The same name will be recorded on the Sign Off when you finish. They can also unlock and edit a signed-off shift later if something needs fixing.',
    target: '.m-sup',
  },
  {
    id: 'order-qty',
    title: 'Order Qty and Job Left',
    narration:
      'The side panel on the right shows the order total and what is left. Order Qty is the JobRequired from planning. Job Left counts down as Good pieces are produced across every shift on this job — not just yours — so two shifts running the same job see the same number drop together.',
    target: '.op-side',
  },
  {
    id: 'cstart',
    title: 'Type the Count Start',
    narration:
      'Read the counter on the press at the start of your shift and tap it into Count Start. This is the only number you need to type before you can start logging — everything else is built up slot by slot through the shift.',
    target: '[data-meta="cstart"]',
    hint: 'The counter on the press is the single most important number — get this one right.',
  },
  {
    id: 'status-tap',
    title: 'Machine Status — tap one half hour',
    narration:
      'The grid in the middle has sixteen columns, one per half hour, eight hours of shift. Tap a single cell to pick a status. A picker opens showing R, B, C, D, I, M, O, P, S — see the legend at the bottom.',
    target: '.row-status',
  },
  {
    id: 'status-drag',
    title: 'Machine Status — drag for many slots',
    narration:
      'For a run of slots all the same status (a long Running stretch, a Breakdown that lasts two hours), put your finger on the first slot, hold, and drag across to the last one. Release and the picker opens once for the whole range.',
    target: '.row-status',
    hint: 'Tip: the highlighted cells turn orange while you drag.',
  },
  {
    id: 'status-clear',
    title: 'Cleared a slot by mistake?',
    narration:
      'The status picker has a "↺ Clear (back to blank)" button at the bottom — tap a wrongly-set cell, pick Clear, and it goes back to a blank dot. No need to choose another letter just to undo.',
  },
  {
    id: 'breakdown',
    title: 'When you pick B — Breakdown cascade',
    narration:
      'B opens a second panel where you pick the breakdown category — Mechanical, Electrical, Hydraulic, Mould, Robot — then the specific cause underneath. The cause shows up in the cell as a tag so engineers can read what to fix without opening Mango.',
  },
  {
    id: 'now-line',
    title: 'The live "now" marker',
    narration:
      'The vertical orange line on the grid is the live wall clock, drawn over the slot you are inside right now. The column it sits in is tinted, so it is hard to fill the wrong half hour by accident.',
    target: '.row-status',
  },
  {
    id: 'rejects',
    title: 'Log the rejects',
    narration:
      'Each row below Machine Status is a defect code. When something goes in the scrap bin, tap the cell under the right half hour and type the piece count. The Total Reject on the right adds them up automatically.',
    target: '.row-named',
    hint: 'Use the same time slot the piece was actually rejected in, not the one you log it in.',
  },
  {
    id: 'handover',
    title: 'Handover notes for the next shift',
    narration:
      'Towards the end of the shift, fill in the four handover boxes. People — staffing changes. Plant — air, water, dryer issues. Machine — press state, mould condition, anything to watch. Material — lot, regrind, masterbatch. The next shift sees this on KPIs.',
    target: '.handover',
  },
  {
    id: 'cend',
    title: 'Type the Count End',
    narration:
      'Read the counter at the end of your shift and tap it into Count End. Total Good appears immediately — it is Count End minus Count Start minus Total Reject. Job Left updates at the same time.',
    target: '[data-meta="cend"]',
  },
  {
    id: 'signoff-open',
    title: 'Sign Off and Save',
    narration:
      'When everything looks right, tap the green Sign Off & Save button at the top right. A confirmation opens with the numbers you are about to commit — Count Start, Count End, Good, Reject, Operator, Supervisor.',
    target: '[data-saveclear]',
  },
  {
    id: 'signoff-confirm',
    title: 'Confirm and you are done',
    narration:
      'Read the summary one more time. If it is correct, tap "Sign off as [your supervisor]". The shift is written to PMD_Production, PMD_BreakDownlog, and PMD_Rejects on SharePoint. A 🔒 orange banner appears at the top so everyone knows the shift is locked.',
  },
  {
    id: 'after-signoff',
    title: 'After Sign Off — what changes',
    narration:
      'The Operator and Supervisor fields become read-only and show the names you just signed off with. To fix anything you need to ask a supervisor to use 🔓 Supervisor at the top right and unlock the shift. The Job# carries forward to the next shift so the same job continues seamlessly — no need to re-pick.',
    target: '.op-meta',
  },
  {
    id: 'kpis',
    title: 'See your numbers on KPIs',
    narration:
      'The 📊 KPIs button at the top opens a roll-up: per machine, per shift, per job, with output, reject, yield, hours, OEE and your handover notes. Use it for the daily morning meeting — the team can drill from the period down to the exact order.',
    target: 'a[href="#/kpi"]',
  },
  {
    id: 'done',
    title: 'That is the whole shift',
    narration:
      'You have just walked through a complete order on the iPad. The 📘 Tutorial button at the top is always here — tap it any time you want to refresh a step. Have a good shift.',
    hint: 'Tap Finish to close.',
  },
];

const SUPERVISOR_STEPS: TutorialStep[] = [
  {
    id: 'sv-welcome',
    title: 'Supervisor: how to unlock a signed-off shift',
    narration:
      'Sometimes you need to fix something on a shift after it was signed off. This short walkthrough shows the four taps that get you there. The whole thing takes one minute.',
    hint: 'Tap Next to start.',
  },
  {
    id: 'sv-banner',
    title: 'Step 1 — Find the orange banner',
    narration:
      'When a shift has been signed off, an orange banner appears at the top of the operator sheet. It tells you who signed off and when. If you do not see a banner right now, that just means the shift you are looking at has not been signed off yet — open a past shift to see one.',
    target: '.lock-banner',
    hint: 'No banner here? Use the ◀ arrow at the top to step back to a past shift.',
  },
  {
    id: 'sv-button',
    title: 'Step 2 — Tap the Unlock button',
    narration:
      'On the right side of the orange banner is an Unlock button. Tap it. A confirmation dialog opens — nothing is changed yet.',
    target: '.lock-unlock-btn',
  },
  {
    id: 'sv-confirm',
    title: 'Step 3 — Read and confirm',
    narration:
      'The dialog shows who signed off, when, and reminds you that the shift will need to be signed off a second time afterwards. If that is okay, tap the orange Unlock button to confirm. The banner disappears and the operator can edit again.',
  },
  {
    id: 'sv-after',
    title: 'Step 4 — After the fix is done',
    narration:
      'Once the operator has fixed what was wrong, they tap ✅ Sign off & Save again. Your name as supervisor is recorded on the new signature. The numbers in the master roll-up are updated.',
    hint: 'Tap Finish to close.',
  },
];

const TRACKS: Record<TutorialTrack, TutorialStep[]> = {
  operator: OPERATOR_STEPS,
  supervisor: SUPERVISOR_STEPS,
};

let host: HTMLElement | null = null;
let idx = 0;
let track: TutorialTrack = 'operator';

function steps(): TutorialStep[] {
  return TRACKS[track];
}

function ensureHost(): HTMLElement {
  // Recreate the host if the variable points at a detached node. SPFx
  // page navigations or a host re-render can yank the original out of
  // body without our knowing; without this guard we'd keep mutating an
  // orphan div and the user would see nothing on Tutorial click.
  if (host && document.body.contains(host)) return host;
  host = document.createElement('div');
  host.className = 'tut-host';
  // Inline the baseline visibility rules so the tutorial still works
  // on a page whose stylesheet didn't load the .tut-host class (an
  // older cached bundle on a SharePoint CDN, a customer who CSP-blocks
  // our css, etc). The CSS file still overrides these with the nicer
  // animations and positioning.
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.zIndex = '2147483000'; // top of stack — beat SP chrome
  host.style.display = 'none';
  host.style.pointerEvents = 'none';
  host.innerHTML = `
    <div class="tut-spotlight" aria-hidden="true"></div>
    <div class="tut-card" role="dialog" aria-modal="true" aria-labelledby="tut-title" style="position:absolute;width:440px;max-width:92vw;background:#fff;border-radius:14px;padding:22px;box-shadow:0 20px 40px rgba(0,0,0,.35);pointer-events:auto">
      <div class="tut-progress"></div>
      <h3 class="tut-title" id="tut-title"></h3>
      <p class="tut-narration"></p>
      <p class="tut-hint"></p>
      <div class="tut-actions">
        <button type="button" class="tut-skip">Skip</button>
        <button type="button" class="tut-prev">◀ Back</button>
        <button type="button" class="tut-next">Next ▶</button>
      </div>
    </div>`;
  document.body.appendChild(host);
  host.querySelector('.tut-skip')!.addEventListener('click', close);
  host.querySelector('.tut-prev')!.addEventListener('click', prev);
  host.querySelector('.tut-next')!.addEventListener('click', next);
  return host;
}

function positionFor(step: TutorialStep): void {
  const h = ensureHost();
  const spot = h.querySelector<HTMLElement>('.tut-spotlight')!;
  const card = h.querySelector<HTMLElement>('.tut-card')!;

  if (!step.target) {
    spot.style.display = 'none';
    card.style.top = '50%';
    card.style.left = '50%';
    card.style.transform = 'translate(-50%, -50%)';
    return;
  }
  const el = document.querySelector<HTMLElement>(step.target);
  if (!el) {
    spot.style.display = 'none';
    card.style.top = '20%';
    card.style.left = '50%';
    card.style.transform = 'translateX(-50%)';
    return;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });

  // Position after the smooth-scroll settles so getBoundingClientRect is right.
  setTimeout(() => {
    const rect = el.getBoundingClientRect();
    spot.style.display = 'block';
    spot.style.top = rect.top - 8 + 'px';
    spot.style.left = rect.left - 8 + 'px';
    spot.style.width = rect.width + 16 + 'px';
    spot.style.height = rect.height + 16 + 'px';

    // Card position. Tall targets like .op-side or .handover used to push
    // the card past the bottom of the viewport because we always offset
    // by rect.bottom + 20 — on an iPad with a 768-px viewport and a
    // 600-px side panel the Next button ended up below the chrome and
    // unreachable. Strategy now: try below → else above → else pin to
    // the bottom edge of the viewport so Next/Back stay tappable. The
    // spotlight on the target stays visible regardless because we use
    // a click-through dark overlay rather than blocking the page.
    card.style.transform = 'none';
    card.style.left = '50%';
    card.style.marginLeft = '-220px'; // half of 440px card width
    card.style.bottom = '';

    const margin = 16;
    const vpH = window.innerHeight;
    // Measure after applying the horizontal styles so the natural
    // height reflects the actual content + wrap.
    const cardH = card.offsetHeight || 280;

    let top: number;
    if (rect.bottom + 20 + cardH + margin <= vpH) {
      top = rect.bottom + 20;
    } else if (rect.top - 20 - cardH - margin >= 0) {
      top = rect.top - 20 - cardH;
    } else {
      // No room either side — pin near the bottom so Next/Back are
      // always one tap away.
      top = vpH - cardH - margin;
    }
    top = Math.max(margin, Math.min(top, vpH - cardH - margin));
    card.style.top = top + 'px';
  }, 220);
}

function showStep(i: number): void {
  // We intentionally do NOT re-route here: changing the hash would call
  // renderOperator() which wipes viewDate / shiftCode / selJob back to
  // today's defaults, making the operator lose whatever past shift they
  // were reviewing. If a step's target lives on a different view, the
  // spotlight just hides itself and the card centres so the narration
  // still reads — the operator can navigate manually if they want to
  // practise on the live UI.
  const all = steps();
  if (i < 0 || i >= all.length) return close();
  const step = all[i];
  const el = ensureHost();
  // Both the .open class (so the bundled stylesheet's transitions
  // apply when available) and inline display: a SharePoint deploy
  // that's serving an older cached CSS missing the .open rule would
  // otherwise leave the host stuck at display:none. Belt-and-braces.
  el.classList.add('open');
  el.style.display = 'block';
  idx = i;
  console.info(`[pmd] tutorial step ${i + 1}/${all.length} — ${step.id}`);
  (el.querySelector('.tut-progress') as HTMLElement).textContent =
    `Step ${i + 1} of ${all.length}`;
  (el.querySelector('.tut-title') as HTMLElement).textContent = step.title;
  (el.querySelector('.tut-narration') as HTMLElement).textContent = step.narration;
  const hintEl = el.querySelector('.tut-hint') as HTMLElement;
  hintEl.textContent = step.hint ?? '';
  hintEl.style.display = step.hint ? '' : 'none';
  (el.querySelector('.tut-prev') as HTMLButtonElement).disabled = i === 0;
  (el.querySelector('.tut-next') as HTMLButtonElement).textContent =
    i === all.length - 1 ? 'Finish ✓' : 'Next ▶';
  positionFor(step);
}

function next(): void {
  if (idx >= steps().length - 1) return close();
  showStep(idx + 1);
}

function prev(): void {
  if (idx === 0) return;
  showStep(idx - 1);
}

function close(): void {
  if (host) {
    host.classList.remove('open');
    host.style.display = 'none';
  }
  try {
    localStorage.setItem(TUTORIAL_KEY, '1');
  } catch {
    // Private mode or storage blocked — fine, tutorial just shows again
    // next time, which is the least surprising fallback.
  }
}

/** Open the tutorial at step 0 — call from a UI button. */
export function startTutorial(which: TutorialTrack = 'operator'): void {
  console.info(`[pmd] startTutorial(${which})`);
  track = which;
  showStep(0);
}

/** First-visit auto-launch (operator track). No-op if dismissed before. */
export function maybeAutoStartTutorial(): void {
  try {
    if (localStorage.getItem(TUTORIAL_KEY)) return;
  } catch {
    return; // storage blocked — don't pester
  }
  // Wait for the initial route to render so target elements exist.
  setTimeout(() => startTutorial('operator'), 800);
}
