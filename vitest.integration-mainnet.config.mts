import { integrationConfig } from "./tests/integration/scope.mts";

// the read-only mainnet integration files (tests/integration/mainnet). they run
// on a schedule in .github/workflows/mainnet-timing.yml, never in ci or a release.
export default integrationConfig("mainnet");
