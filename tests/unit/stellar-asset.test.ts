import { describe, it, expect, vi } from "vitest";
import {
  Address,
  Asset,
  AuthRequiredFlag,
  Keypair,
  StrKey,
  xdr,
  type rpc,
} from "@stellar/stellar-sdk";

import { MAINNET } from "@/lib/config/networks";
import { EMPTY_POSITIONS, type ProtocolPositions } from "@/lib/adapters/positions/interface";
import {
  exitPayoutTokens,
  exitTrustlineGaps,
  readExitPayoutTokens,
  readExitPayouts,
  readWrappedAssets,
  type WrappedAsset,
} from "@/lib/soroban/stellar-asset";
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

function accountEntry(accountId: string, flags: number): rpc.Api.LedgerEntryResult {
  const id = Keypair.fromPublicKey(accountId).xdrPublicKey();
  const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: id }));
  const val = xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: id,
      balance: 10_000_000n,
      seqNum: 1n,
      numSubEntries: 0,
      inflationDest: null,
      flags,
      homeDomain: "",
      thresholds: new Uint8Array([1, 0, 0, 0]),
      signers: [],
      ext: xdr.AccountEntryExt.v0(),
    }),
  );
  return { key, val, lastModifiedLedgerSeq: 1 };
}

// contract instances by id (true for a SAC), and issuer accounts by key with
// their flags; anything not listed is not returned, like a missing entry
function server(
  entries: Record<string, boolean>,
  issuers: Record<string, number> = { [AQUA_ISSUER]: 0, [YBX_ISSUER]: 0 },
) {
  const getLedgerEntries = vi.fn(async (...keys: xdr.LedgerKey[]) => ({
    latestLedger: 1,
    entries: keys.flatMap((k) => {
      if (k.type === "account") {
        const id = StrKey.encodeEd25519PublicKey(
          xdr
            .expectUnionVariant(
              xdr.expectUnionVariant(k, "account").account.accountId,
              "publicKeyTypeEd25519",
            )
            .ed25519.toBytes(),
        );
        return id in issuers ? [accountEntry(id, issuers[id]!)] : [];
      }
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
    expect(got.get(AQUA)).toEqual({
      kind: "credit",
      code: "AQUA",
      issuer: AQUA_ISSUER,
      issuerAuthRequired: false,
    });
    expect(got.get(YBX)).toEqual({
      kind: "credit",
      code: "YBX",
      issuer: YBX_ISSUER,
      issuerAuthRequired: false,
    });
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

  it("refuses a SAC name that is not CODE:ISSUER", async () => {
    const s = server({ [AQUA]: true });
    for (const bad of ["AQUA", "AQUA:not-a-key", `A:B:${AQUA_ISSUER}`]) {
      const read = vi.fn(async () => ({ retval: xdr.ScVal.scvString(bad) }));
      await expect(
        readWrappedAssets(s, MAINNET, [AQUA], USER, { simulateRead: read }),
      ).rejects.toThrow();
    }
  });

  it("refuses to answer for a contract the rpc does not return", async () => {
    const s = server({ [AQUA]: true });
    await expect(
      readWrappedAssets(s, MAINNET, [AQUA, YBX], USER, { simulateRead: nameRead }),
    ).rejects.toThrow(new RegExp(`not returned by the rpc: ${YBX}`));
  });

  it("batches the instance reads and the issuer reads", async () => {
    const s = server({ [AQUA]: true, [YBX]: true, [XLM]: true });
    await readWrappedAssets(s, MAINNET, [AQUA, YBX, XLM], USER, {
      simulateRead: nameRead,
      batchSize: 2,
    });
    // two instance batches, then the two issuers in one
    expect(s.getLedgerEntries).toHaveBeenCalledTimes(3);
  });

  // a new line to an auth_required issuer starts unauthorized, and an issuer
  // account that is gone takes no new lines (change_trust fails no_issuer)
  it("reads whether each issuer lets the account open a usable line", async () => {
    const s = server({ [AQUA]: true, [YBX]: true }, { [AQUA_ISSUER]: AuthRequiredFlag | 2 });
    const got = await readWrappedAssets(s, MAINNET, [AQUA, YBX], USER, { simulateRead: nameRead });
    expect(got.get(AQUA)).toMatchObject({ issuerAuthRequired: true });
    expect(got.get(YBX)).toMatchObject({ issuerAuthRequired: null });
  });
});

describe("exitTrustlineGaps", () => {
  const wrapped = new Map<string, WrappedAsset | null>([
    [AQUA, { kind: "credit", code: "AQUA", issuer: AQUA_ISSUER, issuerAuthRequired: false }],
    [YBX, { kind: "credit", code: "YBX", issuer: YBX_ISSUER, issuerAuthRequired: false }],
    [XLM, { kind: "native" }],
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

  it("reports a missing line whose issuer requires authorization as one the app can't fix", () => {
    const authRequired = new Map(wrapped).set(YBX, {
      kind: "credit",
      code: "YBX",
      issuer: YBX_ISSUER,
      issuerAuthRequired: true,
    });
    expect(exitTrustlineGaps(USER, [], [YBX], authRequired)).toEqual([
      { contractId: YBX, code: "YBX", issuer: YBX_ISSUER, reason: "issuer_requires_authorization" },
    ]);
    // an authorized existing line is fine whatever the issuer's flags
    expect(exitTrustlineGaps(USER, [credit("YBX", YBX_ISSUER)], [YBX], authRequired)).toEqual([]);
  });

  it("reports a missing line whose issuer account no longer exists as one no one can fix", () => {
    const gone = new Map(wrapped).set(YBX, {
      kind: "credit",
      code: "YBX",
      issuer: YBX_ISSUER,
      issuerAuthRequired: null,
    });
    expect(exitTrustlineGaps(USER, [], [YBX], gone)).toEqual([
      { contractId: YBX, code: "YBX", issuer: YBX_ISSUER, reason: "issuer_missing" },
    ]);
    // a line the account already has still receives the payout
    expect(exitTrustlineGaps(USER, [credit("YBX", YBX_ISSUER)], [YBX], gone)).toEqual([]);
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

// a token the tests use as the router's reward token, so a reward payout is
// told apart from the pool tokens
const REWARD = new Asset("RWD", AQUA_ISSUER).contractId(MAINNET.passphrase);
const USDC = new Asset("USDC", YBX_ISSUER).contractId(MAINNET.passphrase);
const POOL = "CAPIOQNULTKVYOJT6X2W2XKGNIVUWZDY72Y42YG6HQKJ7DU7YTHIDQYX";
const INDEX = "24f9c991c44acf33fff5f44031c40385d235dc212d7379e824ba3db1c35371f3";

function concentrated(
  over: Partial<ProtocolPositions["aquariusConcentrated"][number]> = {},
): ProtocolPositions["aquariusConcentrated"][number] {
  return {
    poolAddress: POOL,
    poolIndex: INDEX,
    tokens: [XLM, YBX],
    ranges: [],
    pendingFees: [0n, 0n],
    pendingReward: 0n,
    ...over,
  };
}

describe("exitPayoutTokens", () => {
  it("lists the tokens of every exit the plan runs, once each", () => {
    const positions: ProtocolPositions = {
      ...EMPTY_POSITIONS,
      soroswap: [{ pair: { tokenA: AQUA, tokenB: YBX }, shareBalance: 5n }],
      aquarius: [{ poolIndex: "00", shareBalance: 1n, tokens: [XLM, AQUA] }],
      aquariusConcentrated: [
        concentrated({ ranges: [{ tickLower: -10, tickUpper: 10, liquidity: 3n }] }),
      ],
      blend: [
        {
          poolId: WASM_TOKEN,
          liabilities: new Map(),
          collateral: new Map([[USDC, 7n]]),
          supply: new Map([[XLM, 0n]]),
          emissionReserveTokenIds: [],
        },
      ],
    };
    expect([...exitPayoutTokens(positions)].sort()).toEqual([AQUA, XLM, YBX, USDC].sort());
  });

  // the generator plans no withdraw for these, so nothing pays their tokens out
  it("leaves out pools whose exit pays none of their tokens", () => {
    const positions: ProtocolPositions = {
      ...EMPTY_POSITIONS,
      soroswap: [{ pair: { tokenA: AQUA, tokenB: YBX }, shareBalance: 0n }],
      aquarius: [{ poolIndex: "00", shareBalance: 0n, tokens: [XLM, AQUA] }],
      // kept by discovery only for its reward, which the router pays in its own token
      aquariusConcentrated: [
        concentrated({
          tokens: [USDC, YBX],
          ranges: [{ tickLower: -10, tickUpper: 10, liquidity: 0n }],
          pendingReward: 9n,
        }),
      ],
    };
    expect(exitPayoutTokens(positions)).toEqual([]);
  });

  it("counts a concentrated pool whose only payout is its unpaid fees", () => {
    const positions: ProtocolPositions = {
      ...EMPTY_POSITIONS,
      aquariusConcentrated: [concentrated({ tokens: [USDC, YBX], pendingFees: [0n, 4n] })],
    };
    expect([...exitPayoutTokens(positions)].sort()).toEqual([USDC, YBX].sort());
  });

  it("needs nothing when no position is open", () => {
    expect(exitPayoutTokens(EMPTY_POSITIONS)).toEqual([]);
  });
});

describe("readExitPayouts", () => {
  const s = {} as rpc.Server;
  const STANDARD = "CAUCGDPDPQL4EPMPPFST63VBDVN6H5LMDYM3OTBGJQZTCTM3DE4IWWWB";
  const STANDARD_2 = "CD5N56KLXH7DIACQTZHWZ47CYSGXHUJOT3GVZA5TBWPCN6XATR6U5DPD";

  function deps(
    rewards: Record<string, bigint>,
    poolTokens: (pool: string) => readonly string[] = () => [REWARD],
  ) {
    const readRewardToken = vi.fn(async () => REWARD);
    const readUserReward = vi.fn(
      async (_s: rpc.Server, args: { readonly tokens: readonly string[] }) => {
        const key = args.tokens.join(",");
        if (!(key in rewards)) throw new Error(`no reward stub for ${key}`);
        return rewards[key]!;
      },
    );
    // the router's get_pools answer: one pool per token set
    const readPoolAddress = vi.fn(
      async (_s: rpc.Server, _n: unknown, tokens: readonly string[]): Promise<string> =>
        tokens.includes(YBX) ? STANDARD_2 : STANDARD,
    );
    const readPoolRewardTokens = vi.fn(
      async (_s: rpc.Server, pools: readonly string[]) =>
        new Map(pools.map((p) => [p, poolTokens(p)] as const)),
    );
    return { readRewardToken, readUserReward, readPoolAddress, readPoolRewardTokens };
  }

  // mainnet 2026-10-07, read only: GAPU4W... (no AQUA line) had 768,599,147
  // AQUA pending in concentrated pool CAPIOQ... and its router claim trapped with
  // Error(Contract, #13); its claim on CA4HTZ..., with nothing pending, ran and
  // paid 0
  it("adds the pool's reward token when a concentrated position has a reward", async () => {
    const d = deps({});
    const positions: ProtocolPositions = {
      ...EMPTY_POSITIONS,
      aquariusConcentrated: [concentrated({ pendingReward: 768_599_147n })],
    };
    expect(await readExitPayouts(s, MAINNET, USER, positions, d)).toEqual({
      tokens: [REWARD],
      aquariusRewardToken: REWARD,
    });
    expect(d.readPoolRewardTokens).toHaveBeenCalledWith(s, [POOL]);
    expect(d.readPoolAddress).not.toHaveBeenCalled();
  });

  it("reads a standard pool's reward token only when a reward is pending there", async () => {
    const pending = deps({ [`${XLM},${AQUA}`]: 5n, [`${AQUA},${YBX}`]: 0n });
    const positions: ProtocolPositions = {
      ...EMPTY_POSITIONS,
      aquarius: [
        { poolIndex: INDEX, shareBalance: 1n, tokens: [XLM, AQUA] },
        { poolIndex: INDEX, shareBalance: 1n, tokens: [AQUA, YBX] },
      ],
    };
    const got = await readExitPayouts(s, MAINNET, USER, positions, pending);
    expect([...got.tokens].sort()).toEqual([XLM, AQUA, YBX, REWARD].sort());
    expect(got.aquariusRewardToken).toBe(REWARD);
    const first = pending.readUserReward.mock.calls[0]![1] as unknown as {
      user: string;
      poolIndex: Uint8Array;
      network: unknown;
    };
    expect(first.user).toBe(USER);
    expect(first.poolIndex).toHaveLength(32);
    expect(first.network).toBe(MAINNET);
    // only the pool with a pending reward is resolved and read
    expect(pending.readPoolAddress).toHaveBeenCalledTimes(1);
    expect(pending.readPoolAddress).toHaveBeenCalledWith(s, MAINNET, [XLM, AQUA], INDEX, USER);
    expect(pending.readPoolRewardTokens).toHaveBeenCalledWith(s, [STANDARD]);

    const none = deps({ [`${XLM},${AQUA}`]: 0n, [`${AQUA},${YBX}`]: 0n });
    const nothing = await readExitPayouts(s, MAINNET, USER, positions, none);
    expect([...nothing.tokens].sort()).toEqual([XLM, AQUA, YBX].sort());
    expect(nothing.aquariusRewardToken).toBeUndefined();
    expect(none.readRewardToken).not.toHaveBeenCalled();
    expect(none.readPoolRewardTokens).not.toHaveBeenCalled();
  });

  it("skips the reward read for a pool the plan does not withdraw", async () => {
    const d = deps({});
    const positions: ProtocolPositions = {
      ...EMPTY_POSITIONS,
      aquarius: [{ poolIndex: INDEX, shareBalance: 0n, tokens: [XLM, AQUA] }],
    };
    expect(await readExitPayouts(s, MAINNET, USER, positions, d)).toEqual({
      tokens: [],
      aquariusRewardToken: undefined,
    });
    expect(d.readUserReward).not.toHaveBeenCalled();
  });

  // the pool pays the claim, so a pool storing another token than the router
  // would pay into a line the plan never checked
  it("refuses a paying pool whose reward token is not the router's", async () => {
    const positions: ProtocolPositions = {
      ...EMPTY_POSITIONS,
      aquarius: [
        { poolIndex: INDEX, shareBalance: 1n, tokens: [XLM, AQUA] },
        { poolIndex: INDEX, shareBalance: 1n, tokens: [AQUA, YBX] },
      ],
    };
    const rewards = { [`${XLM},${AQUA}`]: 5n, [`${AQUA},${YBX}`]: 5n };
    await expect(
      readExitPayouts(
        s,
        MAINNET,
        USER,
        positions,
        deps(rewards, (p) => (p === STANDARD_2 ? [USDC] : [REWARD])),
      ),
    ).rejects.toThrow(new RegExp(`${STANDARD_2} pays its rewards in ${USDC}`));
    // a registry naming a second token is refused the same way
    await expect(
      readExitPayouts(
        s,
        MAINNET,
        USER,
        positions,
        deps(rewards, () => [REWARD, USDC]),
      ),
    ).rejects.toThrow(/pays its rewards in/);
  });

  it("fails rather than leave out a reward it could not read", async () => {
    const positions: ProtocolPositions = {
      ...EMPTY_POSITIONS,
      aquarius: [{ poolIndex: INDEX, shareBalance: 1n, tokens: [XLM, AQUA] }],
    };
    await expect(readExitPayouts(s, MAINNET, USER, positions, deps({}))).rejects.toThrow(
      /no reward stub/,
    );
    const brokenRouter = {
      ...deps({ [`${XLM},${AQUA}`]: 1n }),
      readRewardToken: vi.fn(async (): Promise<string> => {
        throw new Error("router instance missing");
      }),
    };
    await expect(readExitPayouts(s, MAINNET, USER, positions, brokenRouter)).rejects.toThrow(
      /router instance missing/,
    );
    const brokenLookup = {
      ...deps({ [`${XLM},${AQUA}`]: 1n }),
      readPoolAddress: vi.fn(async (): Promise<string> => {
        throw new Error("router lists no pool with index");
      }),
    };
    await expect(readExitPayouts(s, MAINNET, USER, positions, brokenLookup)).rejects.toThrow(
      /router lists no pool/,
    );
  });

  it("gives readExitPayoutTokens the same token list", async () => {
    const d = deps({ [`${XLM},${AQUA}`]: 5n });
    const positions: ProtocolPositions = {
      ...EMPTY_POSITIONS,
      aquarius: [{ poolIndex: INDEX, shareBalance: 1n, tokens: [XLM, AQUA] }],
    };
    expect([...(await readExitPayoutTokens(s, MAINNET, USER, positions, d))].sort()).toEqual(
      [XLM, AQUA, REWARD].sort(),
    );
  });
});
