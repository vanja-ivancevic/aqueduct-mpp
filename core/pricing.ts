/**
 * Pricing math — exact integer × decimal, never floats (money).
 *
 * Per-query billing computes `amount = rowsReturned × unitPrice`. `unitPrice` is a decimal string
 * (e.g. "0.0001"); multiplying by a row count with JS floats would drift. We scale to integers via
 * BigInt and format back. Pure + deterministic — lives in core.
 */

/** `unitPrice` (decimal string) × `count` (non-negative integer) → decimal string, exact. */
export function unitsCost(unitPrice: string, count: number): string {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`count must be a non-negative integer, got ${count}`);
  }
  const [intPart, fracPart = ""] = unitPrice.split(".");
  const scaled = BigInt(intPart + fracPart) * BigInt(count); // value in units of 10^-fracLen
  const dec = fracPart.length;
  if (dec === 0) return scaled.toString();

  const s = scaled.toString().padStart(dec + 1, "0");
  const whole = s.slice(0, -dec);
  const frac = s.slice(-dec).replace(/0+$/, ""); // trim trailing zeros
  return frac ? `${whole}.${frac}` : whole;
}
