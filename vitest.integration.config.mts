import { integrationConfig } from "./tests/integration/scope.mts";

// integration tests that block ci and a release: real round trips against live
// testnet (Horizon, Soroban RPC, Friendbot) and offline checks. the read-only
// mainnet files run through vitest.integration-mainnet.config.mts instead.
export default integrationConfig("blocking");
