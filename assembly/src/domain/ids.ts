/**
 * Branded identifier types.
 *
 * These are structurally `string` at runtime but nominally distinct at
 * compile time, so you cannot accidentally pass a `PartId` where a
 * `MachineId` is expected. Construct them through the helper functions,
 * which also normalise casing/whitespace so look-ups are stable.
 */

declare const __brand: unique symbol;
type Brand<K, B> = K & { readonly [__brand]: B };

/**
 * A place work happens: a moulding machine (1300T) or an assembly area
 * (AREA-B). Both are lanes on a board and share one id space.
 */
export type WorkCenterId = Brand<string, 'WorkCenterId'>;
export type ToolId = Brand<string, 'ToolId'>; // a die / mould
export type InsertId = Brand<string, 'InsertId'>; // a die insert / cavity set
export type PartId = Brand<string, 'PartId'>; // finished good or raw material BNO
export type JobId = Brand<string, 'JobId'>; // Epicor JobHead_JobNum
export type ColorId = Brand<string, 'ColorId'>;

const norm = (s: string): string => s.trim();

/** Work-centre ids are matched case-insensitively (`1300t` === `1300T`). */
export const WorkCenterId = (s: string): WorkCenterId =>
  norm(s).toUpperCase() as WorkCenterId;

/**
 * A moulding machine is a work centre; an assembly area is a work centre.
 * These aliases keep each department's code reading in its own vocabulary
 * while staying interchangeable where the board treats them uniformly.
 */
export type MachineId = WorkCenterId;
export const MachineId = WorkCenterId;
export type AreaId = WorkCenterId;
export const AreaId = WorkCenterId;

/** A person on the assembly shift roster. */
export type WorkerId = Brand<string, 'WorkerId'>;
export const WorkerId = (s: string): WorkerId => norm(s) as WorkerId;

/** Die / tool names are free text; compare case-insensitively. */
export const ToolId = (s: string): ToolId => norm(s).toLowerCase() as ToolId;

export const InsertId = (s: string): InsertId =>
  norm(s).toLowerCase() as InsertId;

export const PartId = (s: string): PartId => norm(s) as PartId;

export const JobId = (s: string): JobId => norm(s) as JobId;

export const ColorId = (s: string): ColorId =>
  norm(s).toLowerCase() as ColorId;

/** Read the raw string back out of any branded id. */
export const idValue = (id: { toString(): string }): string => String(id);
