/** Tool arguments arrive typed from native tool calling but as strings from
 *  the XML protocol — these coerce either form. */

export function asString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

export function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(s)) return true;
    if (['false', '0', 'no'].includes(s)) return false;
  }
  return fallback;
}

export function asInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Accepts an already-parsed value or a JSON string (XML protocol). */
export function asJson<T>(v: unknown): T | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return undefined;
  }
}

/** Flattens args to strings for legacy tool handlers that expect them. */
export function stringifyArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args || {})) {
    const s = asString(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}
