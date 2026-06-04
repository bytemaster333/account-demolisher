// post-merge mediator forward: after the user's accountMerge -> mediator lands,
// builds and submits the second envelope:
//   payment(mediator -> destination) + accountMerge(mediator -> userFallbackAddress)
// co-signed via /api/mediator/sign (kind="forward").

import {
  Asset,
  BASE_FEE,
  Horizon,
  Memo,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";

import type { NetworkConfig } from "@/lib/config/networks";
import { requestMediatorSignature } from "@/lib/mediator/client";

export interface MediatorForwardInput {
  readonly mediatorPublicKey: string;
  readonly destination: string;
  // defaults to destination if omitted (frees the mediator account).
  readonly userFallbackAddress?: string;
  readonly memo?: { readonly type: "text" | "id" | "hash" | "return"; readonly value: string };
  readonly network: NetworkConfig;
}

export type MediatorForwardResult =
  | { readonly ok: true; readonly txHash: string }
  | { readonly ok: false; readonly error: string };

// 0.5 XLM buffer for fee margin; accountMerge reclaims the base reserve.
const FORWARD_BUFFER_XLM = "0.5000000";

const FIVE_MINUTES = 300;

export async function submitMediatorForward(
  input: MediatorForwardInput,
): Promise<MediatorForwardResult> {
  const server = new Horizon.Server(input.network.horizon, { allowHttp: false });

  let mediatorAccount: Awaited<ReturnType<typeof server.loadAccount>>;
  try {
    mediatorAccount = await server.loadAccount(input.mediatorPublicKey);
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Could not load mediator account: ${err.message}`
          : "Could not load mediator account.",
    };
  }

  const nativeBalance = mediatorAccount.balances.find((b) => b.asset_type === "native");
  if (!nativeBalance) {
    return { ok: false, error: "Mediator account has no native balance to forward." };
  }

  const forwardAmount = subtractDecimal(nativeBalance.balance, FORWARD_BUFFER_XLM);
  if (compareDecimal(forwardAmount, "0") <= 0) {
    return {
      ok: false,
      error: `Mediator balance ${nativeBalance.balance} XLM is too low to forward after fee buffer.`,
    };
  }

  const fallback = input.userFallbackAddress ?? input.destination;
  const builder = new TransactionBuilder(mediatorAccount, {
    fee: (Number.parseInt(BASE_FEE, 10) * 2).toString(),
    networkPassphrase: input.network.passphrase,
    ...(input.memo ? { memo: memoToSdk(input.memo) } : {}),
  });
  builder.addOperation(
    Operation.payment({
      destination: input.destination,
      asset: Asset.native(),
      amount: forwardAmount,
    }),
  );
  builder.addOperation(Operation.accountMerge({ destination: fallback }));
  builder.setTimeout(FIVE_MINUTES);
  const unsignedTx = builder.build();
  const unsignedXdr = unsignedTx.toEnvelope().toXDR("base64");

  const result = await requestMediatorSignature(unsignedXdr, { kind: "forward" });
  if (!result.ok) {
    return {
      ok: false,
      error: `Mediator rejected the forward envelope (${result.code}): ${result.reason}`,
    };
  }

  try {
    const signed = TransactionBuilder.fromXDR(result.signedXdr, input.network.passphrase);
    const submission = (await server.submitTransaction(signed as Transaction)) as {
      readonly hash?: string;
    };
    return { ok: true, txHash: submission.hash ?? "<unknown-forward-hash>" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Mediator forward submission failed: ${detail}` };
  }
}

// stroop-precision (7 decimal) decimal helpers; avoids pulling in a decimal lib.

function toStroops(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = (frac + "0000000").slice(0, 7);
  return BigInt(whole ?? "0") * 10_000_000n + BigInt(fracPadded || "0");
}

function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const frac = abs % 10_000_000n;
  const fracStr = frac.toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fracStr}`;
}

function subtractDecimal(a: string, b: string): string {
  return fromStroops(toStroops(a) - toStroops(b));
}

function compareDecimal(a: string, b: string): number {
  const diff = toStroops(a) - toStroops(b);
  return diff > 0n ? 1 : diff < 0n ? -1 : 0;
}

function memoToSdk(memo: NonNullable<MediatorForwardInput["memo"]>): Memo {
  switch (memo.type) {
    case "text":
      return Memo.text(memo.value);
    case "id":
      return Memo.id(memo.value);
    case "hash":
      return Memo.hash(memo.value);
    case "return":
      return Memo.return(memo.value);
  }
}
