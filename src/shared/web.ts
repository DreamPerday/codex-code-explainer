export type ProviderMode = 'api' | 'codex';
export type ProviderState = { mode: ProviderMode; baseUrl: string; model: string; stream: boolean; keySet: boolean; rememberKey: boolean; revision: string };
export type ProviderDraft = { mode: ProviderMode; baseUrl: string; model: string; stream: boolean; apiKey?: string; clearKey?: boolean; rememberKey: boolean };
