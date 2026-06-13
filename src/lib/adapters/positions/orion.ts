// REST adapter against the orion positions API. until orion ships a stable schema:
import { RestPositionProvider, type RestProviderOptions } from "./rest-base";

export class OrionProvider extends RestPositionProvider {
  override readonly name = "orion" as const;

  constructor(options: RestProviderOptions = {}) {
    super(options);
  }
}
