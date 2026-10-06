// classic amounts are decimal strings with at most 7 places (one stroop is
// 0.0000001). one strict parse/format pair for every module that does stroop
// math, so a malformed or over-precise value throws everywhere instead of being
// truncated in one place and read as zero in another.

const DECIMAL_AMOUNT = /^(-?)(\d+)(?:\.(\d{1,7}))?$/;

export function decimalToStroops(s: string): bigint {
  const m = DECIMAL_AMOUNT.exec(s);
  if (m === null) {
    throw new Error(`malformed amount "${s}": expected a decimal with at most 7 places`);
  }
  const [, sign = "", intPart = "0", fracPart = ""] = m;
  const result = BigInt(intPart) * 10_000_000n + BigInt(fracPart.padEnd(7, "0"));
  return sign === "-" ? -result : result;
}

// always 7 places, the form horizon uses
export function stroopsToDecimal(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const result = `${abs / 10_000_000n}.${(abs % 10_000_000n).toString().padStart(7, "0")}`;
  return negative ? `-${result}` : result;
}
