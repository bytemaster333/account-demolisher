// REST adapter against the OctoPos positions API. mirrors OrionProvider semantics:
import { RestPositionProvider, type RestProviderOptions } from "./rest-base";

export class OctoposProvider extends RestPositionProvider {
  override readonly name = "octopos" as const;

  constructor(options: RestProviderOptions = {}) {
    super(options);
  }
}
