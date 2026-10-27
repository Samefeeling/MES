import type { ProductDieColor } from '../types';

// A part Planning.csv runs that PMD_ProductDieColor has never heard of — a
// new colour, usually, of a tool the floor already runs. Parts made on one
// die are described alike: the same words, then the colour last
// ("Viva Backrest Navy", "Viva Backrest Grey Green"). So the description
// with its colour taken off names the die, when exactly one die's parts
// share it.
//
// Exact only. What a match writes is master data the operator sheet tells
// the floor which tool to fit from, so a part whose description matches
// several dies, or none, is not guessed at: it is listed for a supervisor.

/** A planned part to place, as Planning.csv describes it. */
export interface NewPart {
  partNumber: string;
  description: string;
}

/** A new part placed on a die, and the row it takes. */
export interface DieMatch extends ProductDieColor {
  description: string;
  /** The registered parts whose descriptions it matched. */
  siblings: string[];
}

export type DieMissReason = 'no-description' | 'no-similar' | 'several-dies';

/** A new part that could not be placed, and why. */
export interface DieMiss {
  partNumber: string;
  description: string;
  reason: DieMissReason;
  /** `several-dies`: the dies whose parts it matched. */
  dies: string[];
}

/**
 * A hot-stamped chair: a moulded part sent through the hot-stamp press
 * for a customer's print ("…\n\nHot Stamp: Back of Backrest"). It runs on
 * no die of its own, so it is never placed on one.
 */
export function isHotStampPart(description: string): boolean {
  return /\bhot\s*-?\s*stamp/i.test(description);
}

const tokens = (s: string): string[] => s.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);

/**
 * A description without its colour: the longest colour the list already
 * knows at the end, else the last word. Null when what is left is under two
 * words — too little to say which tool it is.
 */
export function descriptionStem(
  description: string,
  colours: readonly string[][],
): { stem: string; colour: string[] } | null {
  const words = tokens(description);
  let cut = 0;
  for (const colour of colours) {
    if (colour.length === 0 || colour.length >= words.length) continue;
    const tail = words.slice(words.length - colour.length);
    if (tail.every((w, i) => w === colour[i])) {
      cut = colour.length;
      break;
    }
  }
  if (cut === 0) cut = 1;
  if (words.length - cut < 2) return null;
  return { stem: words.slice(0, words.length - cut).join(' '), colour: words.slice(words.length - cut) };
}

const titleCase = (words: string[]): string =>
  words.map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');

/**
 * Place each new part on the die whose registered parts share its
 * description bar the colour.
 *
 * `known` is PMD_ProductDieColor; `descByPart` the description of each
 * registered part (Planning.csv, then PMD_Production — the list itself has
 * no description column). A match copies the die, its name and category;
 * the colour name is the word(s) taken off, with the hex another part of
 * that colour already carries. CoRun is left off: it is a judgement about
 * two particular parts.
 */
export function matchNewParts(
  newParts: readonly NewPart[],
  known: readonly ProductDieColor[],
  descByPart: ReadonlyMap<string, string>,
): { matches: DieMatch[]; misses: DieMiss[] } {
  const colourNames = new Map<string, string>();
  const hexByColour = new Map<string, Map<string, number>>();
  for (const k of known) {
    const name = k.name.trim();
    if (!name) continue;
    const key = tokens(name).join(' ');
    if (!colourNames.has(key)) colourNames.set(key, name);
    if (k.hex) {
      const held = hexByColour.get(key) ?? new Map<string, number>();
      held.set(k.hex, (held.get(k.hex) ?? 0) + 1);
      hexByColour.set(key, held);
    }
  }
  const colours = [...colourNames.keys()]
    .map((k) => k.split(' '))
    .sort((a, b) => b.length - a.length);

  // Stem → die → the registered parts behind it.
  const byStem = new Map<string, Map<string, ProductDieColor[]>>();
  for (const k of known) {
    if (!k.dieNumber.trim()) continue;
    const desc = descByPart.get(k.partNumber.trim().toUpperCase());
    if (!desc) continue;
    const s = descriptionStem(desc, colours);
    if (!s) continue;
    const dies = byStem.get(s.stem) ?? new Map<string, ProductDieColor[]>();
    const die = k.dieNumber.trim().toUpperCase();
    dies.set(die, [...(dies.get(die) ?? []), k]);
    byStem.set(s.stem, dies);
  }

  const matches: DieMatch[] = [];
  const misses: DieMiss[] = [];
  for (const part of newParts) {
    const description = part.description.trim();
    const miss = (reason: DieMissReason, dies: string[] = []): void => {
      misses.push({ partNumber: part.partNumber, description, reason, dies });
    };
    if (!description) {
      miss('no-description');
      continue;
    }
    const s = descriptionStem(description, colours);
    const dies = s ? byStem.get(s.stem) : undefined;
    if (!s || !dies) {
      miss('no-similar');
      continue;
    }
    if (dies.size > 1) {
      miss('several-dies', [...dies.values()].map((rows) => rows[0].dieNumber.trim()).sort());
      continue;
    }
    const rows = [...dies.values()][0];
    const first = rows[0];
    const colourKey = s.colour.join(' ');
    const hexes = [...(hexByColour.get(colourKey) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]);
    matches.push({
      partNumber: part.partNumber,
      description,
      hex: hexes[0]?.[0] ?? '',
      name: colourNames.get(colourKey) ?? titleCase(s.colour),
      category: rows.find((r) => r.category)?.category ?? '',
      dieNumber: first.dieNumber.trim(),
      die: rows.find((r) => r.die)?.die ?? '',
      coRun: false,
      siblings: rows.map((r) => r.partNumber),
    });
  }
  return { matches, misses };
}
