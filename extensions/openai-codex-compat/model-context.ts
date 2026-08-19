import type { Api, Model } from "@earendil-works/pi-ai";

export type SelectedModelContext = {
  model:
    | {
        id: string;
        provider: string;
      }
    | undefined;
  modelRegistry: {
    find: (provider: string, modelId: string) => Model<Api> | undefined;
  };
};

export function selectedRegistryModel(ctx: SelectedModelContext): Model<Api> | undefined {
  const selected = ctx.model;
  return selected === undefined
    ? undefined
    : ctx.modelRegistry.find(selected.provider, selected.id);
}
