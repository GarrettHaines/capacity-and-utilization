// Deep merge / diff for the two-layer config model.
//
// Effective config = deepMerge(teamDefault, override). teamDefault is one
// shared Settings object; override is a sparse per-user diff kept in
// localStorage. Untouched fields track the team default; changed ones stay the
// user's. deepDiff(edited, teamDefault) produces the sparse override on save.
// Objects merge/diff key by key; arrays and primitives are atomic.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural equality: objects by key-set + values, arrays element-wise, else ===. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Overlay a sparse `patch` onto `base`. Nested objects merge recursively;
 * arrays and primitives replace wholesale. `undefined` in `patch` is skipped,
 * so a pruned override never blanks out a base field.
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? base : (patch as T);
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, pv] of Object.entries(patch)) {
    if (pv === undefined) continue;
    const bv = out[k];
    if (isPlainObject(bv) && isPlainObject(pv)) {
      out[k] = deepMerge(bv, pv);
    } else {
      out[k] = pv;
    }
  }
  return out as T;
}

/**
 * Sparse subtree of `next` that differs from `base`. Recurses into objects
 * (keeping a key only when its diff is non-empty); arrays/primitives compare
 * atomically. Assumes both share the same shape, so keys only in `base` are
 * ignored. Returns `{}` when equal.
 */
export function deepDiff(
  next: unknown,
  base: unknown
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(next)) return out;
  const baseObj = isPlainObject(base) ? base : {};
  for (const [k, nv] of Object.entries(next)) {
    const bv = baseObj[k];
    if (isPlainObject(nv) && isPlainObject(bv)) {
      const sub = deepDiff(nv, bv);
      if (Object.keys(sub).length > 0) out[k] = sub;
    } else if (!deepEqual(nv, bv)) {
      out[k] = nv;
    }
  }
  return out;
}

/** True when `v` is an object with no own keys (or is null/undefined). */
export function isEmptyObject(v: unknown): boolean {
  if (v == null) return true;
  return isPlainObject(v) && Object.keys(v).length === 0;
}

/** `undefined` for an empty/nullish object, else the object. Keeps a sparse
 *  override tidy so an empty slot is dropped instead of persisted as `{}`. */
export function pruneEmpty<T>(v: T): T | undefined {
  return isEmptyObject(v) ? undefined : v;
}
