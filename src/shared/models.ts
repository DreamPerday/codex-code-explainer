export type ReaderModel = { id: string; name: string; description?: string };
export type ModelCatalog = { provider: string; configuredModel?: string; defaultModel?: string; models: ReaderModel[] };
export type ReaderModelSettings = ModelCatalog & { selection: string | null };
