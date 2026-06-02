// Built-in tutorial mode: walks an operator through the daily flow with
// a spotlight on the relevant UI element and a tooltip card. Auto-launches
// once per browser on first visit; always reachable from the top-nav ❓
// button. Content mirrors docs/TRAINING_OPERATOR.md so the two stay in
// sync (printable card for the wall, in-app tour for the screen).

interface TutorialStep {
  id: string;
  title: string;
  narration: string;
  /** Optional CSS selector to spotlight. Omit for centred message cards. */
  target?: string;
  /** Extra one-liner under the narration — usually the "what to look for". */
  hint?: string;
}

const TUTORIAL_KEY = 'pmd_tutorial_seen';

const STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    title: 'Welcome',
    narration:
      'This is a short walkthrough of the operator sheet. It takes about two minutes. We will point to each box so you know what to fill in during your shift. You can stop any time with Skip.',
    hint: 'Tap Next to start.',
  },
  {
    id: 'machine',
    title: 'Pick your machine',
    narration:
      'At the top of the page is a row of boxes. The first one says Machine. Tap it and pick your machine from the list.',
    target: '.m-mc',
  },
  {
    id: 'job',
    title: 'Pick your Job number',
    narration:
      'Next box is Job number. This is your order. Tap to pick from the list. If your job is not in the list yet, you can also type the number directly.',
    target: '.m-job',
  },
  {
    id: 'operator',
    title: 'Pick your name',
    narration:
      'Find the Operator box and pick your own name. This stays for the whole shift.',
    target: '.m-op',
  },
  {
    id: 'supervisor',
    title: 'Pick your Supervisor',
    narration: 'Pick the supervisor on shift with you in the Supervisor box.',
    target: '.m-sup',
  },
  {
    id: 'cstart',
    title: 'Type the starting counter',
    narration:
      'On the right side, find Count Start. Type the counter reading on your machine at clock-in.',
    target: '[data-meta="cstart"]',
  },
  {
    id: 'status',
    title: 'Fill the Machine Status row',
    narration:
      'The big grid in the middle has one cell for every half hour. Tap a cell and pick a letter. R = Running, B = Breakdown, plus seven more letters you can read on the legend.',
    target: '.row-status',
    hint: 'Tip: press and hold, then drag across many cells to fill them all at once.',
  },
  {
    id: 'breakdown',
    title: 'If you pick B (Breakdown)',
    narration:
      'When you tap B, a second panel opens. Pick the category — Mechanical, Electrical, Hydraulic, and so on — then pick the specific cause. This helps the engineers know what to fix.',
  },
  {
    id: 'rejects',
    title: 'Log rejects',
    narration:
      'Under the status row, each row is a defect category. Tap the cell at the right time and type the number of pieces scrapped.',
    target: '.row-named',
  },
  {
    id: 'handover',
    title: 'Hand-over notes',
    narration:
      'Near the end of the shift, write short notes for the next shift in People, Plant, Machine, and Material.',
    target: '.handover',
  },
  {
    id: 'cend',
    title: 'Type the ending counter',
    narration:
      'At the end of your shift, type the final counter into Count End. Total Good appears automatically — it is Count End minus Count Start minus rejects.',
    target: '[data-meta="cend"]',
  },
  {
    id: 'signoff',
    title: 'Sign Off and Save',
    narration:
      'Tap the green Sign Off and Save button at the top right. A summary opens. Check the numbers. If they look right, tap Confirm. Your shift is saved.',
    target: '[data-saveclear]',
  },
  {
    id: 'done',
    title: 'You are done',
    narration:
      'That is the whole shift, every shift, the same steps. The ❓ Tutorial button at the top is always here if you forget. Have a good shift.',
    hint: 'Tap Finish to close.',
  },
];

let host: HTMLElement | null = null;
let idx = 0;

function ensureHost(): HTMLElement {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'tut-host';
  host.innerHTML = `
    <div class="tut-spotlight" aria-hidden="true"></div>
    <div class="tut-card" role="dialog" aria-modal="true" aria-labelledby="tut-title">
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
    // Place card under the target if room below, else above.
    card.style.transform = 'none';
    card.style.left = '50%';
    card.style.marginLeft = '-220px'; // half of 440px card width
    const below = rect.top < window.innerHeight / 2;
    if (below) {
      card.style.top = rect.bottom + 20 + 'px';
      card.style.bottom = '';
    } else {
      card.style.top = '';
      card.style.bottom = window.innerHeight - rect.top + 20 + 'px';
    }
  }, 220);
}

function showStep(i: number): void {
  // The walkthrough targets operator-view DOM; switch to it first if the
  // user kicked the tutorial off from Trace or KPIs.
  const h = window.location.hash;
  if (!h.startsWith('#/op') && h !== '' && h !== '#/' && h !== '#') {
    window.location.hash = '#/';
    requestAnimationFrame(() => requestAnimationFrame(() => showStep(i)));
    return;
  }
  if (i < 0 || i >= STEPS.length) return close();
  const step = STEPS[i];
  const el = ensureHost();
  el.classList.add('open');
  idx = i;
  (el.querySelector('.tut-progress') as HTMLElement).textContent =
    `Step ${i + 1} of ${STEPS.length}`;
  (el.querySelector('.tut-title') as HTMLElement).textContent = step.title;
  (el.querySelector('.tut-narration') as HTMLElement).textContent = step.narration;
  const hintEl = el.querySelector('.tut-hint') as HTMLElement;
  hintEl.textContent = step.hint ?? '';
  hintEl.style.display = step.hint ? '' : 'none';
  (el.querySelector('.tut-prev') as HTMLButtonElement).disabled = i === 0;
  (el.querySelector('.tut-next') as HTMLButtonElement).textContent =
    i === STEPS.length - 1 ? 'Finish ✓' : 'Next ▶';
  positionFor(step);
}

function next(): void {
  if (idx >= STEPS.length - 1) return close();
  showStep(idx + 1);
}

function prev(): void {
  if (idx === 0) return;
  showStep(idx - 1);
}

function close(): void {
  if (host) host.classList.remove('open');
  try {
    localStorage.setItem(TUTORIAL_KEY, '1');
  } catch {
    // Private mode or storage blocked — fine, tutorial just shows again
    // next time, which is the least surprising fallback.
  }
}

/** Open the tutorial at step 0 — call from a UI button. */
export function startTutorial(): void {
  showStep(0);
}

/** First-visit auto-launch. No-op if the user has dismissed it before. */
export function maybeAutoStartTutorial(): void {
  try {
    if (localStorage.getItem(TUTORIAL_KEY)) return;
  } catch {
    return; // storage blocked — don't pester
  }
  // Wait for the initial route to render so target elements exist.
  setTimeout(startTutorial, 800);
}
