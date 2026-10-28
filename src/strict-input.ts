/** Strict ordinary records reject unknown keys at an untrusted input boundary. */
export function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every((key) => keys.includes(key));
}

/** Dense bounded arrays reject holes that Array.every otherwise silently skips. */
export function dense(value: unknown, max: number, check: (entry: unknown) => boolean): value is unknown[] {
  if (!Array.isArray(value) || value.length > max) return false;
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i) || !check(value[i])) return false;
  return true;
}

/** Preserve exact nonblank identities, including surrounding whitespace. */
export function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim().length > 0;
}
