import type { ImageGenerationPort } from "../ports";
import { ProviderConfigurationError } from "../ports";
import { createAPIMartAdapterFromEnvironment } from "./apimart";

export const createImageGenerationProviderFromEnvironment = (): ImageGenerationPort => {
  const provider = (process.env.PAPERDUCK_IMAGE_PROVIDER ?? "apimart").toLowerCase();
  if (provider === "apimart") return createAPIMartAdapterFromEnvironment();
  throw new ProviderConfigurationError(`Unsupported PAPERDUCK_IMAGE_PROVIDER: ${provider}`);
};
