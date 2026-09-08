/**
 * A tiny `Result<T, E>` for fallible operations (parsing, fetching) where we
 * prefer explicit values over thrown exceptions. Keeps the data layer's error
 * handling visible in the types.
 */

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = string> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Unwrap or throw — use only at the edge where you accept failure is fatal. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`unwrap() on Err: ${String(r.error)}`);
}

/** Unwrap or fall back to a default. */
export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T =>
  r.ok ? r.value : fallback;

/** Map the success value, leaving errors untouched. */
export const mapResult = <T, U, E>(
  r: Result<T, E>,
  f: (value: T) => U,
): Result<U, E> => (r.ok ? ok(f(r.value)) : r);

/**
 * Collect an array of results into a single result of an array. Fails fast on
 * the first error. Useful for "parse every row, abort on the first bad one".
 */
export function collect<T, E>(results: Result<T, E>[]): Result<T[], E> {
  const out: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
}

/**
 * Partition results into successes and failures. Useful for "parse every row,
 * keep the good ones and report the bad ones" (lenient parsing).
 */
export function partition<T, E>(
  results: Result<T, E>[],
): { values: T[]; errors: E[] } {
  const values: T[] = [];
  const errors: E[] = [];
  for (const r of results) {
    if (r.ok) values.push(r.value);
    else errors.push(r.error);
  }
  return { values, errors };
}
