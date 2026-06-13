// contract-id allow-list enforcement

import {
  Address,
  Operation,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { isAllowedContract } from "@/lib/config/contracts";
import type { NetworkConfig } from "@/lib/config/networks";

export interface AllowlistViolationDetail {
  // c... strkey of the contract being invoked, or a label if extraction failed
  readonly contractId: string;
  // human-readable reason
  readonly reason: string;
}

// thrown when at least one violation is found
export class AllowlistViolation extends Error {
  public readonly violations: readonly AllowlistViolationDetail[];

  constructor(violations: readonly AllowlistViolationDetail[]) {
    const summary = violations
      .map((v, i) => `  ${i + 1}. ${v.contractId} — ${v.reason}`)
      .join("\n");
    super(`Allow-list violation: ${violations.length} contract invocation(s) blocked.\n${summary}`);
    this.name = "AllowlistViolation";
    this.violations = violations;
  }
}

// throws AllowlistViolation if any contract invocation isn't on the list
// omitting network defaults to mainnet
export function assertTransactionAllowed(
  tx: Transaction | FeeBumpTransaction,
  network?: NetworkConfig,
): void {
  const violations = getViolations(tx, network);
  if (violations.length > 0) throw new AllowlistViolation(violations);
}

// non-throwing variant. returns every violation for ui display
export function getViolations(
  tx: Transaction | FeeBumpTransaction,
  network?: NetworkConfig,
): readonly AllowlistViolationDetail[] {
  const ops = collectOperations(tx);
  const out: AllowlistViolationDetail[] = [];

  for (const op of ops) {
    const detail = inspectOperation(op, network);
    if (detail !== null) out.push(detail);
  }

  return out;
}

// flatten ops, transparently unwrapping a fee-bump wrapper
function collectOperations(tx: Transaction | FeeBumpTransaction): readonly Operation[] {
  const maybeInner = (tx as FeeBumpTransaction).innerTransaction;
  if (maybeInner !== undefined && maybeInner !== null) {
    return maybeInner.operations;
  }
  return (tx as Transaction).operations;
}

// returns null for classical ops or for allow-listed invocations
function inspectOperation(
  op: Operation,
  network: NetworkConfig | undefined,
): AllowlistViolationDetail | null {
  if (op.type !== "invokeHostFunction") return null;

  const ihf = op as Operation.InvokeHostFunction;
  const func = ihf.func;

  let kind: string;
  try {
    kind = func.switch().name;
  } catch {
    return {
      contractId: "<unparseable>",
      reason: "Could not inspect host function discriminant.",
    };
  }

  switch (kind) {
    case "hostFunctionTypeInvokeContract": {
      try {
        const args = func.invokeContract();
        const scAddress = args.contractAddress();
        const addrStrkey = Address.fromScAddress(scAddress).toString();
        if (!addrStrkey.startsWith("C")) {
          return {
            contractId: addrStrkey,
            reason: "Invocation target is not a contract address (expected C... strkey).",
          };
        }
        if (!isAllowedContract(addrStrkey, network)) {
          return {
            contractId: addrStrkey,
            reason: networkAwareReason(network),
          };
        }
        return null;
      } catch (err) {
        return {
          contractId: "<extraction-failed>",
          reason: `Failed to extract contract address: ${(err as Error).message}`,
        };
      }
    }

    case "hostFunctionTypeCreateContract":
    case "hostFunctionTypeCreateContractV2":
      // create_contract deploys new code — never on a pre-existing allow-list
      return {
        contractId: "<create-contract>",
        reason: "Contract-creation host functions are not permitted by this tool.",
      };

    case "hostFunctionTypeUploadContractWasm":
      return {
        contractId: "<upload-wasm>",
        reason: "WASM-upload host functions are not permitted by this tool.",
      };

    default:
      return {
        contractId: `<${kind}>`,
        reason: "Unknown host function discriminant.",
      };
  }
}

function networkAwareReason(network: NetworkConfig | undefined): string {
  if (network === undefined) return "Contract is not on MAINNET_ALLOWLIST.";
  switch (network.id) {
    case "mainnet":
      return "Contract is not on MAINNET_ALLOWLIST.";
    case "testnet":
      return "Contract is not on TESTNET_ALLOWLIST.";
    case "futurenet":
      return "Contract is not on the (empty) FUTURENET allow-list.";
  }
}
