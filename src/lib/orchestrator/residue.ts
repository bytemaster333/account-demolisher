// whether a destination account can receive a residue payment of a credit asset.
// a payment to a line that is missing, not authorized or too full fails the whole
// classic batch, so the line is checked before the option is offered and again
// right before the batch is signed.

export interface DestinationLine {
  readonly asset_type: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;
  readonly balance: string;
  readonly limit?: string;
  readonly buying_liabilities?: string;
  readonly is_authorized?: boolean;
}

// null when the destination can take `amount` of the asset keyed code:issuer,
// otherwise a short reason
export function residueLineProblem(
  destination: string,
  lines: readonly DestinationLine[],
  assetKey: string,
  amount: string,
): string | null {
  const [code, issuer] = assetKey.split(":");
  // paying an asset back to its own issuer needs no trustline
  if (issuer === destination) return null;
  const line = lines.find(
    (b) =>
      (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
      b.asset_code === code &&
      b.asset_issuer === issuer,
  );
  if (!line) return "the destination has no trustline for it";
  if (line.is_authorized !== true)
    return "the issuer has not authorized the destination to hold it";
  if (line.limit === undefined) return "the destination trustline reports no limit";
  const room =
    toStroops(line.limit) - toStroops(line.balance) - toStroops(line.buying_liabilities ?? "0");
  if (room < toStroops(amount)) return "the destination trustline does not have room for it";
  return null;
}

// horizon amounts carry at most 7 decimals
export function toStroops(amount: string): bigint {
  const trimmed = amount.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", frac = ""] = body.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || frac.length > 7) {
    throw new Error(`not a 7-decimal amount: ${amount}`);
  }
  const value = BigInt(whole) * 10_000_000n + BigInt((frac + "0000000").slice(0, 7));
  return negative ? -value : value;
}
