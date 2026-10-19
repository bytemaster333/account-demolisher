// the landing page's copy and rows. keep every claim in step with what the code
// actually does.

import { getPublicEnv } from "@/lib/config/env";

// walletconnect is only in the wallet picker when the build has a project id
// (the same check the wallet kit setup makes), so the page only names it then
export function walletConnectEnabled(): boolean {
  return getPublicEnv().NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID !== undefined;
}

export type HeroRow = {
  readonly label: string;
  readonly statusText: string;
  readonly status: "done" | "active" | "queued";
};

export type CapRow = {
  readonly n: string;
  readonly short: string;
  readonly desc: string;
  readonly exchange: boolean;
  readonly classic: boolean;
};

export type Handle = {
  readonly num: string;
  readonly tag: string;
  readonly label: string;
  readonly desc: string;
};

export type Step = {
  readonly num: string;
  readonly title: string;
  readonly body: string;
  readonly highlight: boolean;
};

export type DryRow = {
  readonly label: string;
  readonly fee: string;
};

export type SecurityRow = {
  readonly num: string;
  readonly title: string;
  readonly body: string;
  readonly icon: string;
};

export type Protocol = {
  readonly initial: string;
  readonly name: string;
};

export type Wallet = {
  readonly initial: string;
  readonly name: string;
};

export type FaqEntry = {
  readonly q: string;
  readonly a: string;
};

export const HERO_ROWS: ReadonlyArray<HeroRow> = [
  { label: "Audit account state", statusText: "done", status: "done" },
  { label: "Withdraw Blend supplies", statusText: "done", status: "done" },
  { label: "Close Soroswap LP position", statusText: "signing", status: "active" },
  { label: "Sell trustline balances", statusText: "queued", status: "queued" },
  { label: "Remove trustlines", statusText: "queued", status: "queued" },
  { label: "Drop signers & data entries", statusText: "queued", status: "queued" },
  { label: "ACCOUNT_MERGE → destination", statusText: "queued", status: "queued" },
];

export const HERO_PCT = 42;

export const CAP_ROWS: ReadonlyArray<CapRow> = [
  {
    n: "01",
    short: "Move asset balances",
    desc: "Send tokens to a destination wallet or exchange.",
    exchange: true,
    classic: true,
  },
  {
    n: "02",
    short: "Remove trustlines",
    desc: "Zero balances and drop every issued-asset trustline.",
    exchange: false,
    classic: true,
  },
  {
    n: "03",
    short: "Cancel offers",
    desc: "Clear classic DEX offers blocking the merge.",
    exchange: false,
    classic: true,
  },
  {
    n: "04",
    short: "Unwind Soroban DeFi",
    desc: "Withdraw Blend, Aquarius and Soroswap positions.",
    exchange: false,
    classic: false,
  },
  {
    n: "05",
    short: "Revoke SEP-41 allowances",
    desc: "Set contract spend approvals back to zero.",
    exchange: false,
    classic: false,
  },
  {
    n: "06",
    short: "ACCOUNT_MERGE",
    desc: "Recover the base reserve and remove the ledger entry.",
    exchange: false,
    classic: false,
  },
];

export const HANDLES: ReadonlyArray<Handle> = [
  {
    num: "01",
    tag: "CLASSIC",
    label: "DEX offers",
    desc: "Open buy and sell orders are cancelled so they stop reserving subentries.",
  },
  {
    num: "02",
    tag: "CLASSIC",
    label: "Trustlines",
    desc: "Issued-asset balances are routed out, then each trustline is removed.",
  },
  {
    num: "03",
    tag: "CLASSIC",
    label: "Data entries",
    desc: "Every account_data key is unset before the merge.",
  },
  {
    num: "04",
    tag: "CLASSIC",
    label: "Signers",
    desc: "Extra signers are stripped and thresholds reset to a clean single-signer state.",
  },
  {
    num: "05",
    tag: "CLASSIC",
    label: "Claimable balances",
    desc: "Claimable balances you can claim right now are settled before the merge.",
  },
  {
    num: "06",
    tag: "SOROBAN",
    label: "Blend positions",
    desc: "Supplies are withdrawn and borrows repaid where you still hold the debt asset, before merge.",
  },
  {
    num: "07",
    tag: "SOROBAN",
    label: "Aquarius pools",
    desc: "AMM positions on Aquarius are exited back into the underlying assets.",
  },
  {
    num: "08",
    tag: "SOROBAN",
    label: "Soroswap LP",
    desc: "Liquidity is withdrawn from Soroswap pairs and routed back to you.",
  },
  {
    num: "09",
    tag: "SOROBAN",
    label: "Blend backstop",
    desc: "Backstop deposits are queued for withdrawal (17 days on the v2 backstop, 21 on v1). The account stays open until the queue unlocks; run the close again then to withdraw and finish it.",
  },
  {
    num: "10",
    tag: "SOROBAN",
    label: "SEP-41 allowances",
    desc: "Outstanding token allowances are zeroed before the account is dropped.",
  },
  {
    num: "11",
    tag: "RESERVE",
    label: "Subentry reserve",
    desc: "Every subentry is removed so the full base reserve is freed at merge.",
  },
  {
    num: "12",
    tag: "MERGE",
    label: "ACCOUNT_MERGE",
    desc: "What is left, native balance and base reserve, is merged to the destination.",
  },
];

export const stepsFor = (walletConnect: boolean): ReadonlyArray<Step> => [
  {
    num: "01",
    title: "Connect",
    body: `Connect through Freighter, xBull, Albedo, Rabet, Lobstr, Hana, Ledger${walletConnect ? ", WalletConnect" : ""}, and more. No keys leave your device.`,
    highlight: false,
  },
  {
    num: "02",
    title: "Audit",
    body: "Every offer, trustline, data entry, signer, claimable balance, and Soroban position attached to the account is discovered.",
    highlight: false,
  },
  {
    num: "03",
    title: "Review & sign",
    body: "The full plan is built up front, with Soroban fees from a live simulation. With a wallet you approve each transaction there; with a pasted secret key the app signs in your browser only after your typed confirmation.",
    highlight: true,
  },
  {
    num: "04",
    title: "Merge",
    body: "Transactions are submitted in dependency order. The account is merged and its base reserve is recovered.",
    highlight: false,
  },
];

export const DRY_STAGED: ReadonlyArray<DryRow> = [
  { label: "Withdraw Blend USDC supply", fee: "0.00010" },
  { label: "Close Soroswap XLM/USDC LP", fee: "0.00012" },
  { label: "Sell trustline balances to XLM", fee: "0.00008" },
  { label: "Remove 3 trustlines and 2 signers", fee: "0.00006" },
  { label: "ACCOUNT_MERGE to destination", fee: "0.00005" },
];

export const SECURITY: ReadonlyArray<SecurityRow> = [
  {
    num: "01",
    title: "Your keys never reach a server",
    body: "Your keys sign in your wallet, or in your browser if you paste a secret key. The only server-side signer is the exchange mediator, which signs its own forward and never sees your key. The app code is open source and you can verify it before connecting.",
    icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  },
  {
    num: "02",
    title: "Every DeFi call is on a hardcoded allow-list",
    body: "DeFi exits call only the hardcoded Blend, Aquarius and Soroswap allow-list, re-verified before each signature. Token revokes and transfers call the token's own contract and are shape-checked before signing.",
    icon: "M9 11l3 3L22 4",
  },
  {
    num: "03",
    title: "No surprise signatures",
    body: "The full plan is built up front and Soroban steps are simulated for real fees. With a wallet you approve every transaction there. With a pasted secret key the app signs locally, only after your typed confirmation.",
    icon: "M7 11V7a5 5 0 0 1 10 0v4",
  },
  {
    num: "04",
    title: "Open source, auditable",
    body: "Apache-2.0 licensed, source on GitHub. Read the code, run it yourself, and verify every contract call.",
    icon: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  },
];

export const PROTOCOLS: ReadonlyArray<Protocol> = [
  { initial: "B", name: "Blend" },
  { initial: "A", name: "Aquarius" },
  { initial: "S", name: "Soroswap" },
];

export const ALL_WALLETS: ReadonlyArray<Wallet> = [
  { initial: "F", name: "Freighter" },
  { initial: "X", name: "xBull" },
  { initial: "A", name: "Albedo" },
  { initial: "R", name: "Rabet" },
  { initial: "L", name: "Lobstr" },
  { initial: "H", name: "Hana" },
  { initial: "L", name: "Ledger" },
  { initial: "W", name: "WalletConnect" },
];

export const faqsFor = (walletConnect: boolean): ReadonlyArray<FaqEntry> => [
  {
    q: "Why can't I just send my balances to an exchange and walk away?",
    a: "Exchanges accept the transfer, but they do not run ACCOUNT_MERGE. Your trustlines, signers, data entries, and the base reserve stay locked in the account until it is merged some other way. Demolisher actually closes the account.",
  },
  {
    q: "Does the app ever see my secret key?",
    a: `No. The wallet integrations (Freighter, xBull, Albedo, Rabet, Lobstr, Hana and more via stellar-wallets-kit, plus Ledger hardware${walletConnect ? " and WalletConnect mobile" : ""}) keep the key on your device. The secret-key fallback is a last-resort option, entered locally in your browser, never sent to a server.`,
  },
  {
    q: "What is the mediator account and why does it exist?",
    a: "When merging to an exchange address that requires a memo, the mediator signs a strict two-operation forward envelope (payment, then merge) so funds arrive with the right memo. It is the only signer of that envelope, never sees your key, and cannot touch your account directly.",
  },
  {
    q: "Which Soroban DeFi protocols are supported?",
    a: "Blend, Aquarius and Soroswap. Each integration calls only the hardcoded official contract addresses, re-verified before every signature.",
  },
  {
    q: "What is the allowance viewer?",
    a: "A standalone tool, at /allowances, that lists the SEP-41 token allowances any account set, found from its whole approve history through Lumeus, our history partner (or the last 7 days of on-chain events on a deployment without a Lumeus key), and lets you revoke them from the wallet that owns the account. Think of it as the Stellar analog of revoke.cash.",
  },
  {
    q: "Is it really open source?",
    a: "Yes. Apache-2.0 licensed, source on GitHub. Read the code and run it yourself.",
  },
];
