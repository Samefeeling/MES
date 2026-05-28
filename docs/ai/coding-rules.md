# Coding Rules

> Conventions for changing this codebase. Follow them to keep it stable.

## Golden rules

1. **The DAL is the only backend seam.** UI (`src/ui`) and core (`src/core`)
   must never import `sharepoint.ts` / `sql.ts` / `azure.ts` directly, nor
   reference SharePoint column names. They depend only on `PmdDataLayer`
   (`src/dal/types.ts`) and domain types (`src/types.ts`).
2. **Core stays pure.** `src/core/*` = pure functions: no DOM, no `fetch`,
   no `window`, no module-level mutable state. This is what makes them
   unit-testable. New business rules go here, with a test.
3. **SharePoint specifics live only in `src/dal/sharepoint.ts`.** Internal
   column names go in `DEFAULT_FIELDS`; never hardcode a column name
   elsewhere.
4. **Field-name changes are config, not code.** If a SP column's internal
   name differs, patch `DEFAULT_FIELDS` (or pass `fieldMap` override to the
   constructor) — don't sprinkle names through the methods.

## Workflow (every change)

```
npm run typecheck   # tsc --noEmit, must be clean
npm test            # vitest, all green (currently 56)
npm run build       # must succeed before committing UI/DAL changes
```

Then commit + push to `claude/rewrite-production-app-e18pD` (updates PR #1).
**Never open a new PR.** Rebase if push is rejected (`git pull --rebase`).

## TypeScript

- `strict` is on, plus `noUnusedLocals/Parameters`, `noImplicitReturns`.
  Unused vars fail the build — prefix intentional throwaways with `_`.
- Prefer `interface` for object shapes, `type` for unions.
- Boundary data (SP REST responses) is untyped at the edge — coerce with the
  `str()/num()/bool()/nullOrNum()/isoDate()` helpers in `sharepoint.ts`,
  type after mapping.

## Comments

- Default to none. Add a comment only when the *why* is non-obvious (a SP
  quirk, a spec rule, a workaround). Don't narrate the *what*.
- Spec references like `(§5.4)` point at `PMD_Dashboard_Spec.md` — keep them
  when they explain intent.

## UI conventions (vanilla DOM)

- Views render by assigning `app.innerHTML = ...` template strings, then a
  `wire()` pass attaches listeners. State lives in a module-level `S` object.
- **Always `escapeHtml()` user/data strings** interpolated into HTML.
- `change`/`blur` events for inputs (fires on commit, survives re-render),
  not `input` (would lose focus on the full re-render).
- Re-render is cheap and full; don't try to surgically patch the DOM.

## Tests

- Business-logic only (Vitest, node env). No DOM/e2e harness.
- Use `tests/helpers.ts` `rec()` / `order()` factories for fixtures.
- When you change a domain rule, update or add a test in the same commit.
- Adding a field to `ProductionRecord`? Update `tests/helpers.ts`,
  `seed.ts`, `lock.ts` placeholder, and `memory.ts` placeholder — they all
  construct full records.

## Commits

- Small, focused, descriptive. Body explains the *why*.
- Don't include the model identifier anywhere in commits/PRs/code.

## Don't

- Don't add runtime dependencies without a strong reason (zero today).
- Don't reintroduce per-slot SharePoint writes — SP uses save-on-signoff
  (see `data-model.md`). Per-slot would blow the 5000-item view threshold.
- Don't hardcode reject/breakdown codes in the UI — read them from the DAL.
