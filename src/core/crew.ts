import type { ProductionRecord } from '../types';

/** Who worked a slice of production: the operators named on its sheets and
 *  the supervisors who signed them off. */
export interface Crew {
  /** Full names, A–Z, one per person. */
  operators: string[];
  /** Supervisors who are not also an operator of the slice — a supervisor
   *  who ran a press is one person, counted with the operators. */
  supervisors: string[];
}

const clean = (s: string | undefined): string => (s ?? '').trim().replace(/\s+/g, ' ');

/** "Maria De Souza" → "Maria". */
export function firstName(name: string): string {
  return clean(name).split(' ')[0] ?? '';
}

function distinct(names: Iterable<string>): string[] {
  const byKey = new Map<string, string>();
  for (const raw of names) {
    const name = clean(raw);
    if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/** The operators on the sheets of these records, each once. */
export function operatorsOf(records: ReadonlyArray<ProductionRecord>): string[] {
  return distinct(records.map((r) => r.operator));
}

/**
 * Everybody on the records: operators off the sheets, supervisors off the
 * sheet's Supervisor and its sign-off. A supervisor signs every press of the
 * shift and runs none, so they belong to the shift and the floor, not to a
 * press.
 */
export function crewOf(records: ReadonlyArray<ProductionRecord>): Crew {
  const operators = operatorsOf(records);
  const taken = new Set(operators.map((n) => n.toLowerCase()));
  const supervisors = distinct(records.flatMap((r) => [r.supervisor, r.lockedBy]))
    .filter((n) => !taken.has(n.toLowerCase()));
  return { operators, supervisors };
}

export function crewSize(crew: Crew): number {
  return crew.operators.length + crew.supervisors.length;
}
