import { describe, expect, it } from "vitest";
import {
  Account,
  Address,
  Asset,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { FXDAO_MAINNET_CONTRACTS } from "@/lib/adapters/fxdao/contracts";
import { MAINNET } from "@/lib/config/networks";
import { assertDefiAuthTree, soroswapPairFor } from "@/lib/soroban/defi-auth-guard";
import type { PlanNode } from "@/lib/plan/tree";

// auth entries recorded by read-only mainnet simulation (2026-10-02) of the exact
// calls the app builds, against real holders. the guard must accept these as-is.
const RECORDED = {
  swap: {
    source: "GA222ECMS2ASZYKWS3ALJ2SS66IJ72EP5QOCX5RIZCHDNU57YFLC2WSO",
    contract: "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH",
    fn: "swap_exact_tokens_for_tokens",
  },
  removeLiquidity: {
    source: "GACXANRYOSGYKYI3CRTSIOFLTCCO3AWIN5IFJEF4VO4OU4IWR4WAQ4ON",
    contract: "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH",
    fn: "remove_liquidity",
  },
  aquariusWithdraw: {
    source: "GACXANRYOSGYKYI3CRTSIOFLTCCO3AWIN5IFJEF4VO4OU4IWR4WAQ4ON",
    contract: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
    fn: "withdraw",
  },
  blendRepay: {
    source: "GDUHSEICX6MRQWRQWW4QQX766FVWTUCOGTLZ5QAH6SL2IVX6NLEIHRKU",
    contract: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
    fn: "submit",
  },
  // recorded 2026-10-06; the router nests the pool's own claim(user)
  aquariusClaim: {
    source: "GACXANRYOSGYKYI3CRTSIOFLTCCO3AWIN5IFJEF4VO4OU4IWR4WAQ4ON",
    contract: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
    fn: "claim",
  },
} as const;
const RECORDED_XDR: Record<
  Exclude<keyof typeof RECORDED, "aquariusClaim">,
  { args: string[]; auth: string[] }
> = {
  swap: {
    args: [
      "AAAACgAAAAAAAAAAAAAAAACYloA=",
      "AAAACgAAAAAAAAAAAAAAAAAAAAA=",
      "AAAAEAAAAAEAAAACAAAAEgAAAAGt785ZruUpaPdgYdSUwlJbdWWfpClqZfSZ7ynlZHfklgAAABIAAAABJbT82FmuwvpjSEOMSJs8PBDJi20hvk/TyzDLaJU++Xc=",
      "AAAAEgAAAAAAAAAANa0QTJaBLOFWlsC06lL3kJ/oj+wcK/YoyI4207/BVi0=",
      "AAAABQAAAABqwH3A",
    ],
    auth: [
      "AAAAAAAAAAAAAAABDdXHEOpqSiOzIgf9Ew6t+cnOiZ9DCOk+T/5T+68QigQAAAAcc3dhcF9leGFjdF90b2tlbnNfZm9yX3Rva2VucwAAAAUAAAAKAAAAAAAAAAAAAAAAAJiWgAAAAAoAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAEAAAACAAAAEgAAAAGt785ZruUpaPdgYdSUwlJbdWWfpClqZfSZ7ynlZHfklgAAABIAAAABJbT82FmuwvpjSEOMSJs8PBDJi20hvk/TyzDLaJU++XcAAAASAAAAAAAAAAA1rRBMloEs4VaWwLTqUveQn+iP7Bwr9ijIjjbTv8FWLQAAAAUAAAAAasB9wAAAAAEAAAAAAAAAAa3vzlmu5Slo92Bh1JTCUlt1ZZ+kKWpl9JnvKeVkd+SWAAAACHRyYW5zZmVyAAAAAwAAABIAAAAAAAAAADWtEEyWgSzhVpbAtOpS95Cf6I/sHCv2KMiONtO/wVYtAAAAEgAAAAEZ8eO7N7dwcAmMtcz6pcALKRf+FuOedCTuKbLCXdd65wAAAAoAAAAAAAAAAAAAAAAAmJaAAAAAAA==",
    ],
  },
  removeLiquidity: {
    args: [
      "AAAAEgAAAAEltPzYWa7C+mNIQ4xImzw8EMmLbSG+T9PLMMtolT75dw==",
      "AAAAEgAAAAGt785ZruUpaPdgYdSUwlJbdWWfpClqZfSZ7ynlZHfklg==",
      "AAAACgAAAAAAAAAAAAAAAAAAA+g=",
      "AAAACgAAAAAAAAAAAAAAAAAAAAA=",
      "AAAACgAAAAAAAAAAAAAAAAAAAAA=",
      "AAAAEgAAAAAAAAAABXA2OHSNhWEbFGckOKuYhO2CyG9QVJC8q7jqcRaPLAg=",
      "AAAABQAAAABqwH3A",
    ],
    auth: [
      "AAAAAAAAAAAAAAABDdXHEOpqSiOzIgf9Ew6t+cnOiZ9DCOk+T/5T+68QigQAAAAQcmVtb3ZlX2xpcXVpZGl0eQAAAAcAAAASAAAAASW0/NhZrsL6Y0hDjEibPDwQyYttIb5P08swy2iVPvl3AAAAEgAAAAGt785ZruUpaPdgYdSUwlJbdWWfpClqZfSZ7ynlZHfklgAAAAoAAAAAAAAAAAAAAAAAAAPoAAAACgAAAAAAAAAAAAAAAAAAAAAAAAAKAAAAAAAAAAAAAAAAAAAAAAAAABIAAAAAAAAAAAVwNjh0jYVhGxRnJDirmITtgshvUFSQvKu46nEWjywIAAAABQAAAABqwH3AAAAAAQAAAAAAAAABGfHjuze3cHAJjLXM+qXACykX/hbjnnQk7imywl3XeucAAAAIdHJhbnNmZXIAAAADAAAAEgAAAAAAAAAABXA2OHSNhWEbFGckOKuYhO2CyG9QVJC8q7jqcRaPLAgAAAASAAAAARnx47s3t3BwCYy1zPqlwAspF/4W4550JO4pssJd13rnAAAACgAAAAAAAAAAAAAAAAAAA+gAAAAA",
    ],
  },
  aquariusWithdraw: {
    args: [
      "AAAAEgAAAAAAAAAABXA2OHSNhWEbFGckOKuYhO2CyG9QVJC8q7jqcRaPLAg=",
      "AAAAEAAAAAEAAAACAAAAEgAAAAEltPzYWa7C+mNIQ4xImzw8EMmLbSG+T9PLMMtolT75dwAAABIAAAABre/OWa7lKWj3YGHUlMJSW3Vln6QpamX0me8p5WR35JY=",
      "AAAADQAAACCy4C/PymyW+K1cvYTneEp3ezbZyWokWUAsT0WEYqq38A==",
      "AAAACQAAAAAAAAAAAAAAAAAAA+g=",
      "AAAAEAAAAAEAAAACAAAACQAAAAAAAAAAAAAAAAAAAAAAAAAJAAAAAAAAAAAAAAAAAAAAAA==",
    ],
    auth: [
      "AAAAAAAAAAAAAAABYDO0JQ5wTjFPsGSXPRhduSLK4L0nK6W/8ZqsVw8SrC8AAAAId2l0aGRyYXcAAAAFAAAAEgAAAAAAAAAABXA2OHSNhWEbFGckOKuYhO2CyG9QVJC8q7jqcRaPLAgAAAAQAAAAAQAAAAIAAAASAAAAASW0/NhZrsL6Y0hDjEibPDwQyYttIb5P08swy2iVPvl3AAAAEgAAAAGt785ZruUpaPdgYdSUwlJbdWWfpClqZfSZ7ynlZHfklgAAAA0AAAAgsuAvz8pslvitXL2E53hKd3s22clqJFlALE9FhGKqt/AAAAAJAAAAAAAAAAAAAAAAAAAD6AAAABAAAAABAAAAAgAAAAkAAAAAAAAAAAAAAAAAAAAAAAAACQAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAE8+iVhwrKqEUvKWKDlZFP06ZwNGR1pFLzhZywtUHoQIQAAAAh3aXRoZHJhdwAAAAMAAAASAAAAAAAAAAAFcDY4dI2FYRsUZyQ4q5iE7YLIb1BUkLyruOpxFo8sCAAAAAkAAAAAAAAAAAAAAAAAAAPoAAAAEAAAAAEAAAACAAAACQAAAAAAAAAAAAAAAAAAAAAAAAAJAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAASql4xyNiwDEGsI6aZjXVRSYI2lYDjNdkvr7EZ/X8Dn2AAAABGJ1cm4AAAACAAAAEgAAAAAAAAAABXA2OHSNhWEbFGckOKuYhO2CyG9QVJC8q7jqcRaPLAgAAAAKAAAAAAAAAAAAAAAAAAAD6AAAAAA=",
    ],
  },
  blendRepay: {
    args: [
      "AAAAEgAAAAAAAAAA6HkRAr+ZGFowtbkIX/7xa2nQTjTXnsAH9JekVv5qyIM=",
      "AAAAEgAAAAAAAAAA6HkRAr+ZGFowtbkIX/7xa2nQTjTXnsAH9JekVv5qyIM=",
      "AAAAEgAAAAAAAAAA6HkRAr+ZGFowtbkIX/7xa2nQTjTXnsAH9JekVv5qyIM=",
      "AAAAEAAAAAEAAAABAAAAEQAAAAEAAAADAAAADwAAAAdhZGRyZXNzAAAAABIAAAABJbT82FmuwvpjSEOMSJs8PBDJi20hvk/TyzDLaJU++XcAAAAPAAAABmFtb3VudAAAAAAACgAAAAAAAAAAAAAAAAAPQkAAAAAPAAAADHJlcXVlc3RfdHlwZQAAAAMAAAAF",
    ],
    auth: [
      "AAAAAAAAAAAAAAABEpzIzGM28f273MDzmDQ0w824X9nqhWl6N4LTGNh0pYAAAAAGc3VibWl0AAAAAAAEAAAAEgAAAAAAAAAA6HkRAr+ZGFowtbkIX/7xa2nQTjTXnsAH9JekVv5qyIMAAAASAAAAAAAAAADoeRECv5kYWjC1uQhf/vFradBONNeewAf0l6RW/mrIgwAAABIAAAAAAAAAAOh5EQK/mRhaMLW5CF/+8Wtp0E40157AB/SXpFb+asiDAAAAEAAAAAEAAAABAAAAEQAAAAEAAAADAAAADwAAAAdhZGRyZXNzAAAAABIAAAABJbT82FmuwvpjSEOMSJs8PBDJi20hvk/TyzDLaJU++XcAAAAPAAAABmFtb3VudAAAAAAACgAAAAAAAAAAAAAAAAAPQkAAAAAPAAAADHJlcXVlc3RfdHlwZQAAAAMAAAAFAAAAAQAAAAAAAAABJbT82FmuwvpjSEOMSJs8PBDJi20hvk/TyzDLaJU++XcAAAAIdHJhbnNmZXIAAAADAAAAEgAAAAAAAAAA6HkRAr+ZGFowtbkIX/7xa2nQTjTXnsAH9JekVv5qyIMAAAASAAAAARKcyMxjNvH9u9zA85g0NMPNuF/Z6oVpejeC0xjYdKWAAAAACgAAAAAAAAAAAAAAAAAPQkAAAAAA",
    ],
  },
};

const AQUARIUS_CLAIM_XDR = {
  args: [
    "AAAAEgAAAAAAAAAABXA2OHSNhWEbFGckOKuYhO2CyG9QVJC8q7jqcRaPLAg=",
    "AAAAEAAAAAEAAAACAAAAEgAAAAEltPzYWa7C+mNIQ4xImzw8EMmLbSG+T9PLMMtolT75dwAAABIAAAABre/OWa7lKWj3YGHUlMJSW3Vln6QpamX0me8p5WR35JY=",
    "AAAADQAAACCy4C/PymyW+K1cvYTneEp3ezbZyWokWUAsT0WEYqq38A==",
  ],
  auth: [
    "AAAAAAAAAAAAAAABYDO0JQ5wTjFPsGSXPRhduSLK4L0nK6W/8ZqsVw8SrC8AAAAFY2xhaW0AAAAAAAADAAAAEgAAAAAAAAAABXA2OHSNhWEbFGckOKuYhO2CyG9QVJC8q7jqcRaPLAgAAAAQAAAAAQAAAAIAAAASAAAAASW0/NhZrsL6Y0hDjEibPDwQyYttIb5P08swy2iVPvl3AAAAEgAAAAGt785ZruUpaPdgYdSUwlJbdWWfpClqZfSZ7ynlZHfklgAAAA0AAAAgsuAvz8pslvitXL2E53hKd3s22clqJFlALE9FhGKqt/AAAAABAAAAAAAAAAE8+iVhwrKqEUvKWKDlZFP06ZwNGR1pFLzhZywtUHoQIQAAAAVjbGFpbQAAAAAAAAEAAAASAAAAAAAAAAAFcDY4dI2FYRsUZyQ4q5iE7YLIb1BUkLyruOpxFo8sCAAAAAA=",
  ],
};

const USDC = new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
const USDC_SAC = USDC.contractId(Networks.PUBLIC);
const XLM_SAC = Asset.native().contractId(Networks.PUBLIC);
const ATTACKER = Keypair.random().publicKey();
const EVIL = Address.contract(new Uint8Array(32).fill(7)).toString();
const POOL_INDEX = "b2e02fcfca6c96f8ad5cbd84e7784a777b36d9c96a2459402c4f458462aab7f0";
const BLEND_POOL = RECORDED.blendRepay.contract;

const addr = (a: string) => nativeToScVal(a, { type: "address" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

function inv(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subs: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract).toScAddress(),
        functionName: fn,
        args,
      }),
    ),
    subInvocations: subs,
  });
}

function entry(root: xdr.SorobanAuthorizedInvocation): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  });
}

function buildTx(
  source: string,
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  auth: xdr.SorobanAuthorizationEntry[],
): Transaction {
  return new TransactionBuilder(new Account(source, "100"), {
    fee: "100",
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args, auth }))
    .setTimeout(300)
    .build();
}

function recordedTx(name: keyof typeof RECORDED, extraAuth: xdr.SorobanAuthorizationEntry[] = []) {
  const meta = RECORDED[name];
  const fixture = name === "aquariusClaim" ? AQUARIUS_CLAIM_XDR : RECORDED_XDR[name];
  return buildTx(
    meta.source,
    meta.contract,
    meta.fn,
    fixture.args.map((a) => xdr.ScVal.fromXdr(a, "base64")),
    [...fixture.auth.map((a) => xdr.SorobanAuthorizationEntry.fromXdr(a, "base64")), ...extraAuth],
  );
}

const node = (n: object) => n as unknown as PlanNode;

const convertNode = (token: string, amount: bigint) =>
  node({
    id: "convert",
    kind: "ConvertSorobanToXLM",
    metadata: {
      kind: "ConvertSorobanToXLM",
      asset: { kind: "contract", contractId: token },
      amount,
    },
  });
const lpNode = node({
  id: "lp",
  kind: "WithdrawSoroswapLp",
  metadata: { kind: "WithdrawSoroswapLp", tokenA: XLM_SAC, tokenB: USDC_SAC, shareBalance: 1000n },
});
const aquariusNode = node({
  id: "aq",
  kind: "WithdrawAquarius",
  metadata: {
    kind: "WithdrawAquarius",
    poolIndex: POOL_INDEX,
    shareAmount: 1000n,
    tokens: [XLM_SAC, USDC_SAC],
  },
});
const repayNode = node({
  id: "repay",
  kind: "RepayBlend",
  metadata: { kind: "RepayBlend", poolId: BLEND_POOL, asset: XLM_SAC, amount: 1_000_000n },
});

const claimNode = node({
  id: "claim",
  kind: "ClaimAquariusRewards",
  metadata: { kind: "ClaimAquariusRewards", poolIndex: POOL_INDEX },
});

const ctx = (user: string) => ({ user, network: MAINNET });

describe("soroswapPairFor", () => {
  it("derives the pair the mainnet factory's get_pair returns for XLM/USDC", () => {
    // factory.get_pair(USDC, XLM) on mainnet returned this address
    const expected = "CAM7DY53G63XA4AJRS24Z6VFYAFSSF76C3RZ45BE5YU3FQS5255OOABP";
    expect(soroswapPairFor(MAINNET, USDC_SAC, XLM_SAC)).toBe(expected);
    expect(soroswapPairFor(MAINNET, XLM_SAC, USDC_SAC)).toBe(expected);
  });
});

describe("assertDefiAuthTree accepts the trees protocols really record", () => {
  it("soroswap swap", () => {
    const tx = recordedTx("swap");
    expect(() =>
      assertDefiAuthTree(convertNode(USDC_SAC, 10_000_000n), tx, ctx(RECORDED.swap.source)),
    ).not.toThrow();
  });
  it("soroswap remove_liquidity", () => {
    const tx = recordedTx("removeLiquidity");
    expect(() =>
      assertDefiAuthTree(lpNode, tx, ctx(RECORDED.removeLiquidity.source)),
    ).not.toThrow();
  });
  it("aquarius withdraw", () => {
    const tx = recordedTx("aquariusWithdraw");
    expect(() =>
      assertDefiAuthTree(aquariusNode, tx, ctx(RECORDED.aquariusWithdraw.source)),
    ).not.toThrow();
  });
  it("blend repay", () => {
    const tx = recordedTx("blendRepay");
    expect(() => assertDefiAuthTree(repayNode, tx, ctx(RECORDED.blendRepay.source))).not.toThrow();
  });
  it("aquarius claim, which nests the pool's claim(user)", () => {
    const tx = recordedTx("aquariusClaim");
    expect(() =>
      assertDefiAuthTree(claimNode, tx, ctx(RECORDED.aquariusClaim.source)),
    ).not.toThrow();
  });
});

describe("assertDefiAuthTree refuses smuggled authorizations", () => {
  const user = RECORDED.swap.source;
  const router = RECORDED.swap.contract;
  const deadline = nativeToScVal(1_791_000_000n, { type: "u64" });

  function evilSwap(
    subs: xdr.SorobanAuthorizedInvocation[],
    extra: xdr.SorobanAuthorizationEntry[] = [],
  ) {
    const pair = soroswapPairFor(MAINNET, EVIL, XLM_SAC);
    const args = [
      i128(500n),
      i128(1n),
      xdr.ScVal.scvVec([addr(EVIL), addr(XLM_SAC)]),
      addr(user),
      deadline,
    ];
    const transfer = inv(EVIL, "transfer", [addr(user), addr(pair), i128(500n)], subs);
    return buildTx(user, router, "swap_exact_tokens_for_tokens", args, [
      entry(inv(router, "swap_exact_tokens_for_tokens", args, [transfer])),
      ...extra,
    ]);
  }

  it("accepts a hostile token's swap when its transfer authorizes nothing deeper", () => {
    expect(() =>
      assertDefiAuthTree(convertNode(EVIL, 500n), evilSwap([]), ctx(user)),
    ).not.toThrow();
  });

  it("refuses a hostile token whose transfer nests XLM-SAC.transfer(user, attacker)", () => {
    const drain = inv(XLM_SAC, "transfer", [addr(user), addr(ATTACKER), i128(9_000_000_000n)]);
    expect(() => assertDefiAuthTree(convertNode(EVIL, 500n), evilSwap([drain]), ctx(user))).toThrow(
      /authorizes 1 nested call\(s\), expected 0/,
    );
  });

  it("accepts a one-hop route, whose user transfer goes to the first pair", () => {
    const hop = USDC_SAC;
    const args = [
      i128(500n),
      i128(1n),
      xdr.ScVal.scvVec([addr(EVIL), addr(hop), addr(XLM_SAC)]),
      addr(user),
      deadline,
    ];
    const build = (pair: string) =>
      buildTx(user, router, "swap_exact_tokens_for_tokens", args, [
        entry(
          inv(router, "swap_exact_tokens_for_tokens", args, [
            inv(EVIL, "transfer", [addr(user), addr(pair), i128(500n)]),
          ]),
        ),
      ]);
    const firstPair = soroswapPairFor(MAINNET, EVIL, hop);
    expect(() =>
      assertDefiAuthTree(convertNode(EVIL, 500n), build(firstPair), ctx(user)),
    ).not.toThrow();
    // the token's own pair with XLM is not where a one-hop swap pays in
    expect(() =>
      assertDefiAuthTree(
        convertNode(EVIL, 500n),
        build(soroswapPairFor(MAINNET, EVIL, XLM_SAC)),
        ctx(user),
      ),
    ).toThrow(/not expected/);
  });

  it("refuses a swap rooted anywhere but the pinned soroswap router", () => {
    const fake = Address.contract(new Uint8Array(32).fill(9)).toString();
    const args = [
      i128(500n),
      i128(1n),
      xdr.ScVal.scvVec([addr(EVIL), addr(XLM_SAC)]),
      addr(user),
      deadline,
    ];
    const pair = soroswapPairFor(MAINNET, EVIL, XLM_SAC);
    const tx = buildTx(user, fake, "swap_exact_tokens_for_tokens", args, [
      entry(
        inv(fake, "swap_exact_tokens_for_tokens", args, [
          inv(EVIL, "transfer", [addr(user), addr(pair), i128(500n)]),
        ]),
      ),
    ]);
    expect(() => assertDefiAuthTree(convertNode(EVIL, 500n), tx, ctx(user))).toThrow(
      /not the SoroswapRouter/,
    );
  });

  it("refuses an aquarius claim whose pool claim nests a drain", () => {
    const claimUser = RECORDED.aquariusClaim.source;
    const args = AQUARIUS_CLAIM_XDR.args.map((a) => xdr.ScVal.fromXdr(a, "base64"));
    const aquaRouter = RECORDED.aquariusClaim.contract;
    const pool = "CA6PUJLBYKZKUEKLZJMKBZLEKP2OTHANDEOWSFF44FTSYLKQPIICCJBE";
    const tx = buildTx(claimUser, aquaRouter, "claim", args, [
      entry(
        inv(aquaRouter, "claim", args, [
          inv(
            pool,
            "claim",
            [addr(claimUser)],
            [inv(XLM_SAC, "transfer", [addr(claimUser), addr(ATTACKER), i128(1n)])],
          ),
        ]),
      ),
    ]);
    expect(() => assertDefiAuthTree(claimNode, tx, ctx(claimUser))).toThrow(/not expected/);
  });

  it("refuses extra root entries (standalone SAC transfer and set_admin)", () => {
    const extra = [
      entry(inv(XLM_SAC, "transfer", [addr(user), addr(ATTACKER), i128(1n)])),
      entry(inv(USDC_SAC, "set_admin", [addr(ATTACKER)])),
    ];
    expect(() =>
      assertDefiAuthTree(convertNode(USDC_SAC, 10_000_000n), recordedTx("swap", extra), ctx(user)),
    ).toThrow(/expected 1 authorization entry, got 3/);
  });

  it("refuses a sibling drain recorded next to the LP transfer", () => {
    const lpUser = RECORDED.removeLiquidity.source;
    const fixture = RECORDED_XDR.removeLiquidity;
    const args = fixture.args.map((a) => xdr.ScVal.fromXdr(a, "base64"));
    const pair = soroswapPairFor(MAINNET, XLM_SAC, USDC_SAC);
    const tx = buildTx(lpUser, RECORDED.removeLiquidity.contract, "remove_liquidity", args, [
      entry(
        inv(RECORDED.removeLiquidity.contract, "remove_liquidity", args, [
          inv(pair, "transfer", [addr(lpUser), addr(pair), i128(1000n)]),
          inv(XLM_SAC, "transfer", [addr(lpUser), addr(ATTACKER), i128(1n)]),
        ]),
      ),
    ]);
    expect(() => assertDefiAuthTree(lpNode, tx, ctx(lpUser))).toThrow(
      /authorizes 2 nested call\(s\), expected 1/,
    );
  });

  it("refuses a swap whose transfer pays somewhere other than the soroswap pair", () => {
    const args = [
      i128(500n),
      i128(1n),
      xdr.ScVal.scvVec([addr(EVIL), addr(XLM_SAC)]),
      addr(user),
      deadline,
    ];
    const tx = buildTx(user, router, "swap_exact_tokens_for_tokens", args, [
      entry(
        inv(router, "swap_exact_tokens_for_tokens", args, [
          inv(EVIL, "transfer", [addr(user), addr(ATTACKER), i128(500n)]),
        ]),
      ),
    ]);
    expect(() => assertDefiAuthTree(convertNode(EVIL, 500n), tx, ctx(user))).toThrow(/arg 1 is G/);
  });

  it("refuses address credentials", () => {
    const fixture = RECORDED_XDR.swap;
    const recorded = xdr.SorobanAuthorizationEntry.fromXdr(fixture.auth[0]!, "base64");
    const withAddress = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(ATTACKER).toScAddress(),
          nonce: 1n,
          signatureExpirationLedger: 1,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: recorded.rootInvocation,
    });
    const tx = buildTx(
      user,
      router,
      "swap_exact_tokens_for_tokens",
      fixture.args.map((a) => xdr.ScVal.fromXdr(a, "base64")),
      [withAddress],
    );
    expect(() => assertDefiAuthTree(convertNode(USDC_SAC, 10_000_000n), tx, ctx(user))).toThrow(
      /sorobanCredentialsAddress/,
    );
  });

  it("refuses an authorized root that differs from the invoked call", () => {
    const fixture = RECORDED_XDR.swap;
    const args = fixture.args.map((a) => xdr.ScVal.fromXdr(a, "base64"));
    const recorded = xdr.SorobanAuthorizationEntry.fromXdr(fixture.auth[0]!, "base64");
    const otherArgs = [...args];
    otherArgs[1] = i128(5n);
    const tx = buildTx(user, router, "swap_exact_tokens_for_tokens", otherArgs, [recorded]);
    expect(() => assertDefiAuthTree(convertNode(USDC_SAC, 10_000_000n), tx, ctx(user))).toThrow(
      /authorized root differs/,
    );
  });

  it("refuses a blend withdraw that authorizes any nested call", () => {
    const blendUser = RECORDED.blendRepay.source;
    const req = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: nativeToScVal("address", { type: "symbol" }), val: addr(XLM_SAC) }),
      new xdr.ScMapEntry({ key: nativeToScVal("amount", { type: "symbol" }), val: i128(5n) }),
      new xdr.ScMapEntry({
        key: nativeToScVal("request_type", { type: "symbol" }),
        val: nativeToScVal(3, { type: "u32" }),
      }),
    ]);
    const args = [addr(blendUser), addr(blendUser), addr(blendUser), xdr.ScVal.scvVec([req])];
    const withdrawNode = node({
      id: "w",
      kind: "WithdrawBlend",
      metadata: { kind: "WithdrawBlend", poolId: BLEND_POOL, asset: XLM_SAC, bucket: "collateral" },
    });
    const clean = buildTx(blendUser, BLEND_POOL, "submit", args, [
      entry(inv(BLEND_POOL, "submit", args)),
    ]);
    expect(() => assertDefiAuthTree(withdrawNode, clean, ctx(blendUser))).not.toThrow();
    const dirty = buildTx(blendUser, BLEND_POOL, "submit", args, [
      entry(
        inv(BLEND_POOL, "submit", args, [
          inv(XLM_SAC, "transfer", [addr(blendUser), addr(ATTACKER), i128(1n)]),
        ]),
      ),
    ]);
    expect(() => assertDefiAuthTree(withdrawNode, dirty, ctx(blendUser))).toThrow(
      /authorizes 1 nested call\(s\), expected 0/,
    );
  });

  it("refuses a blend repay whose transfer is larger than the repay request", () => {
    const blendUser = RECORDED.blendRepay.source;
    const fixture = RECORDED_XDR.blendRepay;
    const args = fixture.args.map((a) => xdr.ScVal.fromXdr(a, "base64"));
    const tx = buildTx(blendUser, BLEND_POOL, "submit", args, [
      entry(
        inv(BLEND_POOL, "submit", args, [
          inv(XLM_SAC, "transfer", [addr(blendUser), addr(BLEND_POOL), i128(2_000_000n)]),
        ]),
      ),
    ]);
    expect(() => assertDefiAuthTree(repayNode, tx, ctx(blendUser))).toThrow(/arg 2 is 2000000/);
  });

  it("checks fxdao pay_debt targets the pinned vaults and burns only a pinned stablecoin", () => {
    const vaults = FXDAO_MAINNET_CONTRACTS.find((c) => c.kind === "vaults")!.id;
    const usdx = FXDAO_MAINNET_CONTRACTS.find((c) => c.name === "USDx (SAC)")!.id;
    const other = Address.contract(new Uint8Array(32).fill(4)).toString();
    const vaultKey = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: nativeToScVal("account", { type: "symbol" }), val: addr(user) }),
      new xdr.ScMapEntry({
        key: nativeToScVal("denomination", { type: "symbol" }),
        val: nativeToScVal("USD", { type: "symbol" }),
      }),
      new xdr.ScMapEntry({
        key: nativeToScVal("index", { type: "symbol" }),
        val: nativeToScVal(5n, { type: "u128" }),
      }),
    ]);
    const none = xdr.ScVal.scvVec([nativeToScVal("None", { type: "symbol" })]);
    const args = [none, vaultKey, none, nativeToScVal(700n, { type: "u128" })];
    const fxNode = node({
      id: "fx",
      kind: "PayFxDAODebt",
      metadata: { kind: "PayFxDAODebt", vaultDenomination: "USD", debt: 700n, collateral: 9n },
    });
    const build = (burnContract: string, root = vaults) =>
      buildTx(user, root, "pay_debt", args, [
        entry(inv(root, "pay_debt", args, [inv(burnContract, "burn", [addr(user), i128(700n)])])),
      ]);
    expect(() => assertDefiAuthTree(fxNode, build(usdx), ctx(user))).not.toThrow();
    expect(() => assertDefiAuthTree(fxNode, build(XLM_SAC), ctx(user))).toThrow(/would burn XLM/);
    expect(() => assertDefiAuthTree(fxNode, build(other), ctx(user))).toThrow(
      /not one of fxdao's pinned stablecoins/,
    );
    expect(() => assertDefiAuthTree(fxNode, build(usdx, other), ctx(user))).toThrow(
      /not the fxdao vaults contract/,
    );
  });

  it("fails closed on a transaction it cannot read as one contract call", () => {
    const tx = new TransactionBuilder(new Account(user, "1"), {
      fee: "100",
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "5" }))
      .setTimeout(300)
      .build();
    expect(() => assertDefiAuthTree(lpNode, tx, ctx(user))).toThrow(/operation is bumpSequence/);
  });

  it("refuses kinds that have their own guard or are not soroban steps", () => {
    const tx = recordedTx("swap");
    const transferNode = node({
      id: "t",
      kind: "TransferAsIs",
      metadata: { kind: "TransferAsIs" },
    });
    expect(() => assertDefiAuthTree(transferNode, tx, ctx(user))).toThrow(
      /checked by its own guard/,
    );
  });

  it("refuses a step kind it has no expected tree for", () => {
    const unknown = node({ id: "n", kind: "SomeNewExit", metadata: { kind: "SomeNewExit" } });
    expect(() => assertDefiAuthTree(unknown, recordedTx("swap"), ctx(user))).toThrow(
      /has no expected authorization tree/,
    );
  });
});
