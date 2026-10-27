import assert from "node:assert/strict";

// Independent decimal rational oracle for canonical Number.toString USD/1k -> picoUSD.
export function expectedPico(bytes: number, price: number): bigint {
  assert(Number.isSafeInteger(bytes) && bytes > 0 && Number.isFinite(price) && price >= 0);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(price.toString());
  assert(match);
  const digits = BigInt(match[1]! + (match[2] ?? ""));
  const exponent = Number(match[3] ?? 0) - (match[2]?.length ?? 0) + 9;
  const numerator = BigInt(bytes) * digits * (exponent >= 0 ? 10n ** BigInt(exponent) : 1n);
  const denominator = exponent < 0 ? 10n ** BigInt(-exponent) : 1n;
  return (numerator + denominator - 1n) / denominator;
}
function bitsToNumber(bits: bigint): number {
  const buffer = new ArrayBuffer(8), view = new DataView(buffer);
  view.setBigUint64(0, bits); return view.getFloat64(0);
}
export function adjacentPrices(maxBytes: number): [number, number] {
  const safe = BigInt(Number.MAX_SAFE_INTEGER);
  let lo = 0n, hi = 0x7fefffffffffffffn;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (expectedPico(maxBytes, bitsToNumber(mid)) <= safe) lo = mid;
    else hi = mid - 1n;
  }
  assert(lo < 0x7fefffffffffffffn);
  return [bitsToNumber(lo), bitsToNumber(lo + 1n)];
}
