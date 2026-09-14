/**
 * Which line builds a part, decided from its BOM.
 *
 * This replaces the description-keyword rules the board used to place orders
 * with ("does the part description contain 'cut'?"). Those read the label on
 * the box; this reads what is inside it. A part whose direct children are
 * resin by the kilo is moulded whatever it is called, and a part that
 * consumes a cut panel plus glue is upholstery even if nobody wrote
 * "Foamed Up" in the description.
 *
 * Transcribed from the plant's own `classify-lines.mjs` v4. The rule numbers
 * (P0, R1, R2…), their order, and the evidence wording are kept so a result
 * here can be read against that script's `--report` output line for line.
 *
 * TWO PRINCIPLES CARRIED OVER FROM THE SCRIPT, both load-bearing:
 *
 *  1. **Direct children only.** The BOM already expresses the process
 *     boundary in its levels. Recursing into grandchildren drags the
 *     downstream operation's materials up into this node and every assembly
 *     starts looking like moulding.
 *  2. **Never guess.** No rule fires → UNKNOWN, and the caller leaves the
 *     order where ERP put it rather than inventing a line for it.
 */

/** What a component *is*, as far as choosing a line is concerned. */
export type MaterialClass =
  | 'RESIN'
  | 'FACE_FABRIC'
  | 'FOAM'
  | 'ADHESIVE'
  | 'LINING'
  | 'STAPLE'
  | 'FASTENER'
  | 'HARDWARE'
  | 'PANEL'
  | 'BOARD'
  | 'LABEL'
  | 'COMPONENT';

interface MaterialRule {
  class: MaterialClass;
  partNum?: RegExp;
  desc?: RegExp;
  /** Only match when the line is issued in one of these units. */
  uom?: string[];
}

/**
 * The material dictionary — the one part of these rules that needs ongoing
 * maintenance. Part-number prefix is tried before description, and the first
 * rule that matches wins, so order within the list is meaningful.
 */
const MATERIAL_CLASSES: MaterialRule[] = [
  // Moulding feedstock: resin, masterbatch and regrind, always by the kilo.
  { class: 'RESIN', partNum: /^PMV?\d/i, uom: ['kg'] },
  {
    class: 'RESIN',
    desc: /polypropylene|copolymer|masterbatch|duralon|regrind|\bABS\b|nylon|polyamide/i,
    uom: ['kg'],
  },

  // Face fabric: the cloth, issued by the metre.
  { class: 'FACE_FABRIC', desc: /^think plus|^vinyl|^fabric[: ]|^leather/i, uom: ['m'] },

  // Upholstery consumables.
  { class: 'FOAM', partNum: /^FMV?\d/i },
  { class: 'FOAM', desc: /^foam[: ]/i },
  { class: 'ADHESIVE', partNum: /^ADV?\d/i },
  { class: 'ADHESIVE', desc: /^glue[: ]|^adhesive|^contact cement/i },
  { class: 'LINING', desc: /^calico[: ]|^wadding|^dacron|^scrim/i },
  { class: 'STAPLE', desc: /^staple[: ]/i },

  // Hardware and fixings.
  { class: 'FASTENER', partNum: /^(SBV?|NUV?|MCV?|WAV?)\d/i },
  { class: 'FASTENER', desc: /screw|^nut[: ]|nutsert|^washer[: ]|^bolt|rivet|^stud|surefix|^staple/i },
  { class: 'HARDWARE', partNum: /^(MGV?|CTV?)\d/i },
  { class: 'HARDWARE', desc: /^castor[: ]|^o-ring|^eyelet|^glide|^connector|^hinge|^gas ?lift/i },

  // Structure and packaging. Neutral: present on every line, so they decide
  // nothing on their own and only ever appear as supporting evidence.
  { class: 'PANEL', partNum: /^TBV?\d/i },
  { class: 'PANEL', desc: /^panel /i },
  { class: 'BOARD', partNum: /^CBV?\d/i },
  { class: 'BOARD', desc: /^cardboard[: ]/i },
  { class: 'LABEL', partNum: /^LLV?\d/i },
  { class: 'LABEL', desc: /^label[: ]/i },
];

/** Smart Softies is a separate bench: only two people hold the skill, so its
 *  capacity is not interchangeable with ordinary upholstery. */
const SMART_SOFTIES = /smart soft/i;
/** Hot stamping runs on the moulding side. */
const HOT_STAMP_DESC = /hot ?stamp|stamped|\/stamp/i;
const HOT_STAMP_CODE = /^HST|STMP/i;
const SMART_SOFTIES_ROOT = /^SSOT/i;
/** Configurator placeholders are never built and never scheduled. */
const PLACEHOLDER = /^CP-/i;

/** The classifier's own verdict. Mapped onto a board line by the caller —
 *  this module deliberately knows nothing about swimlanes. */
export type LineRuleKey = 'PMD' | 'CUT' | 'UPH' | 'SSU' | 'ASM' | 'EXCLUDE' | 'UNKNOWN';

/**
 * How much the verdict can be leaned on.
 *
 *  · `high`    — exactly one rule fired.
 *  · `ruled`   — several fired and priority settled it, or a documented
 *                ruling (an Asm with no BOM rows) decided it. Worth a look.
 *  · `none`    — nothing fired.
 */
export type LineConfidence = 'high' | 'ruled' | 'none';

export interface LineVerdict {
  key: LineRuleKey;
  confidence: LineConfidence;
  /** Why, in the script's own words — shown in the inspector and the report. */
  evidence: string[];
}

/** One BOM line as this module needs it: the component and how it is issued. */
export interface BomChild {
  partNum: string;
  partDesc: string;
  uom: string;
  qty: number | null;
  /** Is this component itself built by a production order? A finished
   *  sub-assembly is a different signal from a raw material. */
  isSubAssembly: boolean;
}

/** The part being classified. */
export interface BomNode {
  partNum: string;
  partDesc: string;
  /** The finished product this part rolls up into, for the SSOT ruling.
   *  Empty when the part is the finished product, or the chain is unknown. */
  rootPart?: string;
}

/** What a component is. Unmatched components are neutral "made or bought". */
export function classifyMaterial(partNum: string, desc: string, uom: string): MaterialClass {
  const pn = String(partNum ?? '').trim();
  const d = String(desc ?? '').trim();
  const u = String(uom ?? '').trim().toLowerCase();
  for (const r of MATERIAL_CLASSES) {
    if (r.uom && !r.uom.includes(u)) continue;
    if (r.partNum && r.partNum.test(pn)) return r.class;
    if (r.desc && r.desc.test(d)) return r.class;
  }
  return 'COMPONENT';
}

/**
 * The line for one part, from its direct BOM children.
 *
 * Rules fire in order and every hit is recorded, but the verdict is the
 * highest-priority one: PMD > CUT > UPH > ASM. A part that trips two rules is
 * still placed — the plant would rather have it on the wrong line and flagged
 * than sitting in the unplaced pool — but it is returned as `ruled`, not
 * `high`, so the report can list it for someone to check.
 */
export function classifyLineFromBom(node: BomNode, kids: ReadonlyArray<BomChild>): LineVerdict {
  // P0 — configurator placeholder. Never built, so never scheduled.
  if (PLACEHOLDER.test(node.partNum ?? '')) {
    return { key: 'EXCLUDE', confidence: 'high', evidence: ['P0 CP- prefix — configurator placeholder'] };
  }

  // P1 — a part with a production order but no BOM rows behind it. Almost
  // always a fabric colourway whose master data was never expanded; the
  // plant's ruling is that these go to cutting rather than nowhere.
  if (kids.length === 0) {
    return {
      key: 'CUT',
      confidence: 'ruled',
      evidence: ['P1 no BOM rows for this part; ruled to UPL-CUT (usually a fabric colourway)'],
    };
  }

  const ev: string[] = [];
  const classed = kids.map((k) => ({ k, c: classifyMaterial(k.partNum, k.partDesc, k.uom) }));
  const has = (c: MaterialClass): BomChild[] => classed.filter((x) => x.c === c).map((x) => x.k);

  const resin = has('RESIN');
  const fabric = has('FACE_FABRIC');
  const foam = has('FOAM');
  const glue = has('ADHESIVE');
  const lining = has('LINING');
  const fast = has('FASTENER');
  const hard = has('HARDWARE');

  const cutChildren = kids.filter((k) => k.isSubAssembly && /^cut fab/i.test(k.partDesc));
  const selfIsCut = /^cut fab/i.test(node.partDesc ?? '');

  const fired: LineRuleKey[] = [];

  // R1 — moulding: resin or masterbatch issued by the kilo.
  if (resin.length) {
    fired.push('PMD');
    ev.push(`R1 ${resin.length} moulding feedstock line${resin.length === 1 ? '' : 's'} (${resin.map((r) => r.partNum).join(', ')}) issued by the kilo`);
    if (/mould|moulding|molding/i.test(node.partDesc ?? '')) ev.push('R1b description says Moulding — corroborates');
  }

  // R1s — hot stamping, which ERP runs on the moulding side.
  if (!fired.length && (HOT_STAMP_CODE.test(node.partNum ?? '') || HOT_STAMP_DESC.test(node.partDesc ?? ''))) {
    fired.push('PMD');
    ev.push('R1s hot-stamped part; ruled to PMD');
  }

  // R2 — cutting: called a Cut Fab, or nothing but cloth by the metre.
  const onlyFabric = kids.length > 0 && classed.every((x) => x.c === 'FACE_FABRIC');
  if (selfIsCut || onlyFabric) {
    fired.push('CUT');
    if (selfIsCut) ev.push('R2 description starts with "Cut Fab"');
    if (onlyFabric) ev.push(`R2b every component is face fabric by the metre (${fabric.map((f) => f.partNum).join(', ')})`);
  }

  // R3 — upholstery: foam, glue or lining, or it consumes a cut sub-assembly.
  if (foam.length || glue.length || lining.length || cutChildren.length) {
    fired.push('UPH');
    if (foam.length) ev.push(`R3 ${foam.length} foam line${foam.length === 1 ? '' : 's'}`);
    if (glue.length) ev.push(`R3 adhesive ${glue.map((g) => g.partNum).join(', ')}`);
    if (lining.length) ev.push(`R3 lining/wadding ${lining.map((l) => l.partNum).join(', ')}`);
    if (cutChildren.length) ev.push(`R3c consumes cut sub-assembly ${cutChildren.map((c) => c.partNum).join(', ')}`);
    if (/foamed up|foam up/i.test(node.partDesc ?? '')) ev.push('R3d description says "Foamed Up" — corroborates');
  }

  // R4 — assembly, the catch-all: it is built, and it is not any of the above.
  if (!fired.length) {
    const asmKids = kids.filter((k) => k.isSubAssembly);
    fired.push('ASM');
    if (fast.length) ev.push(`R4 ${fast.length} fastener line${fast.length === 1 ? '' : 's'}`);
    if (hard.length) ev.push(`R4 ${hard.length} hardware line${hard.length === 1 ? '' : 's'}`);
    if (asmKids.length) ev.push(`R4 consumes ${asmKids.length} finished sub-assembl${asmKids.length === 1 ? 'y' : 'ies'}`);
    if (!fast.length && !hard.length && !asmKids.length) {
      ev.push(`R4 catch-all: ${kids.length} component line${kids.length === 1 ? '' : 's'}, no moulding, cutting or upholstery signal`);
    }
    // One component at quantity one is usually a labelling variant rather
    // than a real operation. Placed anyway, but said out loud.
    if (kids.length === 1 && Number(kids[0].qty) === 1) {
      ev.unshift(`?? single component at qty 1 (${kids[0].partNum}) — looks like a variant code, not an operation; worth checking`);
    }
  }

  let key: LineRuleKey = fired[0]; // priority: PMD > CUT > UPH > ASM

  // R5 — Smart Softies is its own bench, by skill not by process.
  if (key === 'UPH') {
    const byDesc = SMART_SOFTIES.test(node.partDesc ?? '');
    const byRoot = SMART_SOFTIES_ROOT.test(node.rootPart ?? '');
    if (byDesc || byRoot) {
      key = 'SSU';
      ev.push(byDesc ? 'R5 description says "Smart Soft" — moved to the SSS bench' : `R5 rolls up into SSOT product ${node.rootPart} — moved to the SSS bench`);
      if (byRoot && !byDesc) ev.push('!! placed on the finished product alone; check if this part is also used outside SSOT');
    }
  }

  if (fired.length > 1) {
    ev.unshift(`!! ${fired.length} rules fired (${fired.join(' + ')}); priority chose ${key} — needs confirming`);
  }
  return { key, confidence: fired.length === 1 ? 'high' : 'ruled', evidence: ev };
}
