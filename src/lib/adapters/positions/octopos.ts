/**
 * REST adapter against the OctoPos positions API. mirrors OrionProvider semantics:
 * isAvailable() returns false when the proxy can't reach the upstream;
 * getPositions throws ProviderUnavailable; 2xx responses validate against the schema.
 * the browser side never reads OCTOPOS_API_KEY — the key lives server-side.
 */

import { RestPositionProvider, type RestProviderOptions } from "./rest-base";

export class OctoposProvider extends RestPositionProvider {
  override readonly name = "octopos" as const;

  constructor(options: RestProviderOptions = {}) {
    super(options);
  }
}
