import type { StatusCode, StatusKind } from '../types';

export interface StatusDef {
  code: StatusCode;
  label: string;
  color: string;
  border: string;
  text: string;
  kind: StatusKind;
}

// §2.2 Status Codes. `kind` drives KPI rollups:
//   production -> Output (R)
//   downtime   -> Downtime hrs (B, M)
//   setup      -> Setup time hrs (C, D, I, P, S)
//   idle       -> not counted as downtime or setup (O)
export const STATUSES: StatusDef[] = [
  { code: 'R', label: 'Running', color: '#86efac', border: '#16a34a', text: '#14532d', kind: 'production' },
  { code: 'B', label: 'Breakdown', color: '#fca5a5', border: '#dc2626', text: '#7f1d1d', kind: 'downtime' },
  { code: 'C', label: 'Color Change', color: '#fde68a', border: '#d97706', text: '#78350f', kind: 'setup' },
  { code: 'D', label: 'Die Change', color: '#fed7aa', border: '#ea580c', text: '#7c2d12', kind: 'setup' },
  { code: 'I', label: 'Insert Change', color: '#fed7aa', border: '#c2410c', text: '#7c2d12', kind: 'setup' },
  { code: 'M', label: 'Smoko', color: '#fbcfe8', border: '#db2777', text: '#831843', kind: 'downtime' },
  { code: 'O', label: 'No Work', color: '#e5e7eb', border: '#9ca3af', text: '#374151', kind: 'idle' },
  { code: 'P', label: 'Purge', color: '#e9d5ff', border: '#9333ea', text: '#581c87', kind: 'setup' },
  { code: 'S', label: 'Startup', color: '#bae6fd', border: '#0284c7', text: '#075985', kind: 'setup' },
];

export const STATUS_MAP: Record<string, StatusDef> = Object.fromEntries(
  STATUSES.map((s) => [s.code, s]),
);

// §8.2 — regular orders show a green "Confirm running" plus 8 abnormal pills.
export const ABNORMAL_CODES: StatusCode[] = ['B', 'C', 'D', 'I', 'M', 'O', 'P', 'S'];

// §5.3 / §8.2 — Die Change orders hide Run and only offer these.
export const DIE_CHANGE_CODES: StatusCode[] = ['B', 'C', 'D', 'I', 'M'];

export function statusKind(code: StatusCode | ''): StatusKind | null {
  if (!code) return null;
  return STATUS_MAP[code]?.kind ?? null;
}

// §16 Appendix B — priority when a slot is ambiguous (lower number wins).
const DECISION_PRIORITY: StatusCode[] = ['R', 'B', 'D', 'C', 'I', 'M', 'P', 'S', 'O'];

/** Given the set of plausible codes for a slot, return the one to record. */
export function resolveAmbiguousStatus(candidates: StatusCode[]): StatusCode | null {
  for (const code of DECISION_PRIORITY) {
    if (candidates.includes(code)) return code;
  }
  return null;
}
