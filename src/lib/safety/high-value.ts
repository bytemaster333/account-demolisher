// High-value safety gate. A close of an account holding a large XLM balance must
// require an explicit acknowledgement before it can proceed, so a big irreversible
// merge is never one careless click away. This module is the gate's pure logic
// (trigger + acknowledgement bookkeeping), kept free of any wallet/UI imports so
// it is unit-testable in isolation.

export const HIGH_VALUE_THRESHOLD_XLM = 1000;

// The high-value gate's TRIGGER: true when the account's total XLM STRICTLY
// exceeds the threshold. A non-numeric total never trips the gate.
export function isHighValueTotalXlm(
  totalXlm: string,
  threshold: number = HIGH_VALUE_THRESHOLD_XLM,
): boolean {
  const n = Number.parseFloat(totalXlm);
  return Number.isFinite(n) && n > threshold;
}

// Which acknowledgement checkboxes the acknowledge step must collect before the
// user can continue, given which advisory conditions are present. High value is
// one of them.
export function requiredAcknowledgements(flags: {
  readonly hasScam: boolean;
  readonly hasDiscovery: boolean;
  readonly hasAutoHandled: boolean;
  readonly hasHighValue: boolean;
}): string[] {
  return [
    flags.hasScam ? "scam" : null,
    flags.hasDiscovery ? "discovery" : null,
    flags.hasAutoHandled ? "autoHandled" : null,
    flags.hasHighValue ? "highValue" : null,
  ].filter((k): k is string => k !== null);
}

// The gate is cleared only when EVERY required acknowledgement is ticked.
export function allAcknowledged(
  required: readonly string[],
  acks: Readonly<Record<string, boolean>>,
): boolean {
  return required.every((k) => acks[k] === true);
}
