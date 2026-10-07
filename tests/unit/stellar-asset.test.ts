import { describe, it, expect, vi } from "vitest";
import { Address, Asset, Keypair, xdr, type rpc } from "@stellar/stellar-sdk";

import { MAINNET } from "@/lib/config/networks";
import { exitTrustlineGaps, readWrappedAssets } from "@/lib/soroban/stellar-asset";
import type { AuditBalance } from "@/lib/types/account";

const USER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
// the two sides of mainnet soroswap pair CBKG7Y3L...
const AQUA_ISSUER = "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";
const YBX_ISSUER = "GBUYYBXWCLT2MOSSHRFCKMEDFOVSCAXNIEW424GLN666OEXHAAWBDYMX";
const AQUA = new Asset("AQUA", AQUA_ISSUER).contractId(MAINNET.passphrase);
const YBX = new Asset("YBX", YBX_ISSUER).contractId(MAINNET.passphrase);
const XLM = Asset.native().contractId(MAINNET.passphrase);
// a wasm token (the soroswap pair itself)
const WASM_TOKEN = "CBKG7Y3LSLTSK76LCKM52EQP3I7GMGL2VOR6S46ZEJZW62WFPAKP4NIG";

function instanceEntry(contractId: string, sac: boolean): rpc.Api.LedgerEntryResult {
  const executable = sac
    ? xdr.ContractExecutable.contractExecutableStellarAsset()
    : xdr.ContractExecutable.contractExecutableWasm(new Uint8Array(32).fill(7));
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
    }),
  );
  return { key, val, lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 100 };
}

function server(entries: Record<string, boolean>) {
  const getLedgerEntries = vi.fn(async (...keys: xdr.LedgerKey[]) => ({
    latestLedger: 1,
    entries: keys.flatMap((k) => {
      const id = Address.fromScAddress(
        xdr.expectUnionVariant(k, "contractData").contractData.contract,
      ).toString();
      return id in entries ? [instanceEntry(id, entries[id]!)] : [];
    }),
  }));
  return { getLedgerEntries } as unknown as rpc.Server & {
    getLedgerEntries: typeof getLedgerEntries;
  };
}

const names: Record<string, string> = {
  [AQUA]: `AQUA:${AQUA_ISSUER}`,
  [YBX]: `YBX:${YBX_ISSUER}`,
  [XLM]: "native",
};
const nameRead = vi.fn(async (_s: rpc.Server, id: string) => ({
  retval: xdr.ScVal.scvString(names[id] ?? "LIE:" + AQUA_ISSUER),
}));

function credit(code: string, issuer: string, isAuthorized = true): AuditBalance {
  return {
    asset: { kind: "credit", code, issuer },
    amount: "0",
    buyingLiabilities: "0",
    sellingLiabilities: "0",
    isAuthorized,
  };
}

describe("readWrappedAssets", () => {
  it("names the classic asset behind each SAC and nothing for a wasm token", async () => {
    nameRead.mockClear();
    const s = server({ [AQUA]: true, [YBX]: true, [XLM]: true, [WASM_TOKEN]: false });
    const got = await readWrappedAssets(s, MAINNET, [AQUA, YBX, XLM, WASM_TOKEN, AQUA], USER, {
      simulateRead: nameRead,
    });
    expect(got.get(AQUA)).toEqual({ kind: "credit", code: "AQUA", issuer: AQUA_ISSUER });
    expect(got.get(YBX)).toEqual({ kind: "credit", code: "YBX", issuer: YBX_ISSUER });
    expect(got.get(XLM)).toEqual({ kind: "native" });
    expect(got.get(WASM_TOKEN)).toBeNull();
    // the wasm token's own code is never run to answer the question
    expect(nameRead.mock.calls.map((c) => c[1])).not.toContain(WASM_TOKEN);
  });

  it("refuses a SAC whose name derives to a different contract", async () => {
    const s = server({ [AQUA]: true });
    const lying = vi.fn(async () => ({ retval: xdr.ScVal.scvString(`YBX:${YBX_ISSUER}`) }));
    await expect(
      readWrappedAssets(s, MAINNET, [AQUA], USER, { simulateRead: lying }),
    ).rejects.toThrow(/refusing to trust it/);
  });

  it("refuses to answer for a contract the rpc does not return", async () => {
    const s = server({ [AQUA]: true });
    await expect(
      readWrappedAssets(s, MAINNET, [AQUA, YBX], USER, { simulateRead: nameRead }),
    ).rejects.toThrow(new RegExp(`not returned by the rpc: ${YBX}`));
  });

  it("batches the instance reads", async () => {
    const s = server({ [AQUA]: true, [YBX]: true, [XLM]: true });
    await readWrappedAssets(s, MAINNET, [AQUA, YBX, XLM], USER, {
      simulateRead: nameRead,
      batchSize: 2,
    });
    expect(s.getLedgerEntries).toHaveBeenCalledTimes(2);
  });
});

describe("exitTrustlineGaps", () => {
  const wrapped = new Map([
    [AQUA, { kind: "credit" as const, code: "AQUA", issuer: AQUA_ISSUER }],
    [YBX, { kind: "credit" as const, code: "YBX", issuer: YBX_ISSUER }],
    [XLM, { kind: "native" as const }],
    [WASM_TOKEN, null],
  ]);

  // the mainnet holder of CBKG7Y3L... had an AQUA line and no YBX line
  it("names the payout asset the account has no trustline for", () => {
    expect(exitTrustlineGaps(USER, [credit("AQUA", AQUA_ISSUER)], [AQUA, YBX], wrapped)).toEqual([
      { contractId: YBX, code: "YBX", issuer: YBX_ISSUER, reason: "missing" },
    ]);
  });

  it("needs nothing for XLM, a wasm token or an asset the account issues", () => {
    expect(exitTrustlineGaps(USER, [], [XLM, WASM_TOKEN], wrapped)).toEqual([]);
    expect(exitTrustlineGaps(YBX_ISSUER, [], [YBX], wrapped)).toEqual([]);
  });

  it("reports a line the issuer has not authorized, which a change_trust cannot fix", () => {
    expect(exitTrustlineGaps(USER, [credit("YBX", YBX_ISSUER, false)], [YBX], wrapped)).toEqual([
      { contractId: YBX, code: "YBX", issuer: YBX_ISSUER, reason: "unauthorized" },
    ]);
  });

  it("refuses a token it was not given an answer for", () => {
    const other = Keypair.random().publicKey();
    expect(() =>
      exitTrustlineGaps(
        USER,
        [],
        [new Asset("ZZZ", other).contractId(MAINNET.passphrase)],
        wrapped,
      ),
    ).toThrow(/was not resolved/);
  });
});
