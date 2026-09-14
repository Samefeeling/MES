/**
 * The BOM rules, checked against the plant's own `classify-lines.mjs` v4.
 *
 * Every case here is one the description-keyword rules got wrong or could not
 * see at all — which is why the descriptions are deliberately unhelpful.
 */

import { describe, it, expect } from 'vitest';
import { classifyLineFromBom, classifyMaterial, type BomChild } from '@/domain/lineRules';

const kid = (over: Partial<BomChild> = {}): BomChild => ({
  partNum: 'X1',
  partDesc: 'Widget',
  uom: 'EA',
  qty: 2,
  isSubAssembly: false,
  ...over,
});

const resin = kid({ partNum: 'PM1042', partDesc: 'Polypropylene copolymer natural', uom: 'kg' });
const fabric = kid({ partNum: 'FB2201', partDesc: 'Think Plus Charcoal', uom: 'm' });
const foam = kid({ partNum: 'FM0031', partDesc: 'Foam: 25mm chip', uom: 'EA' });
const glue = kid({ partNum: 'AD0004', partDesc: 'Glue: contact spray', uom: 'EA' });
const screw = kid({ partNum: 'SB0100', partDesc: 'Screw M6 x 20 pan head', uom: 'EA' });

describe('classifyMaterial', () => {
  it('reads resin only when it is issued by the kilo', () => {
    expect(classifyMaterial('PM1042', 'Polypropylene copolymer', 'kg')).toBe('RESIN');
    // The same code on a one-off EA line is not a moulding charge — most
    // likely a sample or a returned lot — and must not make the part moulded.
    expect(classifyMaterial('PM1042', 'Polypropylene copolymer', 'EA')).toBe('COMPONENT');
  });

  it('reads face fabric only by the metre', () => {
    expect(classifyMaterial('FB2201', 'Think Plus Charcoal', 'm')).toBe('FACE_FABRIC');
    expect(classifyMaterial('FB2201', 'Think Plus Charcoal', 'EA')).toBe('COMPONENT');
  });

  it('classes the upholstery consumables and the fixings', () => {
    expect(classifyMaterial('FM0031', 'Foam: 25mm chip', 'EA')).toBe('FOAM');
    expect(classifyMaterial('AD0004', 'Glue: contact spray', 'EA')).toBe('ADHESIVE');
    expect(classifyMaterial('', 'Calico: 900mm', 'm')).toBe('LINING');
    expect(classifyMaterial('SB0100', 'Screw M6', 'EA')).toBe('FASTENER');
    expect(classifyMaterial('MG0900', 'Castor: 50mm braked', 'EA')).toBe('HARDWARE');
  });

  it('treats anything it does not recognise as a neutral component', () => {
    expect(classifyMaterial('ZZ9', 'Something nobody listed', 'EA')).toBe('COMPONENT');
  });
});

describe('classifyLineFromBom', () => {
  const node = (partNum: string, partDesc = '', rootPart = '') => ({ partNum, partDesc, rootPart });

  it('P0 never schedules a configurator placeholder', () => {
    const v = classifyLineFromBom(node('CP-SOFA-3ST'), [resin]);
    expect(v.key).toBe('EXCLUDE');
    expect(v.confidence).toBe('high');
  });

  it('P1 rules a part with no BOM rows to cutting, and says it was a ruling', () => {
    const v = classifyLineFromBom(node('FBC-STORM'), []);
    expect(v.key).toBe('CUT');
    expect(v.confidence).toBe('ruled');
    expect(v.evidence[0]).toMatch(/no BOM rows/);
  });

  it('R1 moulds anything charged resin by the kilo, whatever it is called', () => {
    const v = classifyLineFromBom(node('V11694', 'Ned Stool shell, amber'), [resin, screw]);
    expect(v.key).toBe('PMD');
    expect(v.confidence).toBe('high');
    expect(v.evidence.join(' ')).toMatch(/PM1042/);
  });

  it('R1s sends a hot-stamped part to moulding', () => {
    expect(classifyLineFromBom(node('HST0041', 'Arm cap /stamp'), [screw]).key).toBe('PMD');
    expect(classifyLineFromBom(node('A1', 'Podium arm hot stamped'), [screw]).key).toBe('PMD');
  });

  it('R2 cuts a part whose components are all cloth by the metre', () => {
    const v = classifyLineFromBom(node('CS0900', 'Podium Back Pad'), [fabric, kid({ partNum: 'FB9', partDesc: 'Vinyl Storm', uom: 'm' })]);
    expect(v.key).toBe('CUT');
    // Nothing in that description says "cut". The BOM does.
    expect(v.evidence.join(' ')).toMatch(/face fabric by the metre/);
  });

  it('R3 upholsters on foam, glue or a cut sub-assembly', () => {
    expect(classifyLineFromBom(node('U1', 'Integra Chair - UV'), [foam, screw]).key).toBe('UPH');
    expect(classifyLineFromBom(node('U2'), [glue]).key).toBe('UPH');
    const consumesCut = kid({ partNum: 'CS0900', partDesc: 'Cut Fab Storm', isSubAssembly: true });
    expect(classifyLineFromBom(node('U3'), [consumesCut, screw]).key).toBe('UPH');
  });

  it('R4 is the catch-all, and flags a single component at quantity one', () => {
    const v = classifyLineFromBom(node('A9', 'Podium Chair Final Assy & Pack'), [
      kid({ partNum: 'SUB1', isSubAssembly: true, qty: 1 }),
    ]);
    expect(v.key).toBe('ASM');
    expect(v.evidence[0]).toMatch(/variant code/);
  });

  it('R5 moves upholstery onto the SSS bench, by description or by product', () => {
    expect(classifyLineFromBom(node('S1', 'Orbit Smart Softies pad'), [foam]).key).toBe('SSU');
    const byRoot = classifyLineFromBom(node('S2', 'Orbit pad', 'SSOT-600'), [foam]);
    expect(byRoot.key).toBe('SSU');
    expect(byRoot.evidence.join(' ')).toMatch(/check if this part is also used outside SSOT/);
  });

  it('takes the highest-priority rule when several fire, and says so', () => {
    // Resin AND foam: moulding wins, but this is not a confident answer.
    const v = classifyLineFromBom(node('M1'), [resin, foam]);
    expect(v.key).toBe('PMD');
    expect(v.confidence).toBe('ruled');
    expect(v.evidence[0]).toMatch(/^!! 2 rules fired/);
  });

  it('reads direct children only — a grandchild cannot make an assembly moulded', () => {
    // The shell is moulded; the chair that consumes the finished shell is not.
    const shell = kid({ partNum: 'V11694', partDesc: 'Ned Stool shell, amber', isSubAssembly: true });
    expect(classifyLineFromBom(node('CSSL01436', 'Ned Stool'), [shell, screw]).key).toBe('ASM');
  });
});
