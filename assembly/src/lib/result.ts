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
