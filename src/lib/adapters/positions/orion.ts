/**
 * REST adapter against the Orion positions API. until orion ships a stable schema:
 *  - isAvailable() returns false when ORION_API_URL is unset or the proxy 5xxs
 *  - getPositions throws ProviderUnavailable on unreachable/unconfigured upstream
 *  - 2xx responses validate against the schema; drift → ProviderSchemaMismatch
 * the browser side never reads ORION_API_KEY — the key lives server-side.
 */

import { RestPositionProvider, type RestProviderOptions } from "./rest-base";

export class OrionProvider extends RestPositionProvider {
  override readonly name = "orion" as const;

  constructor(options: RestProviderOptions = {}) {
    super(options);
  }
}
