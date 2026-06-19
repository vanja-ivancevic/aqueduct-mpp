/**
 * Result — errors as values, not exceptions.
 *
 * Extraction/eval/parse failures carry structured, localized diagnostics that the
 * repair loop consumes. Throwing would discard that. So fallible core functions return a Result.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
