import type { ThemeMode } from '../shared/language-api';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234/v1';

interface PersistedInferenceProviderBase {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedOpenAiProviderConfig
  extends PersistedInferenceProviderBase {
  kind: 'openai';
  apiKey: string;
  organizationId: string | null;
  projectId: string | null;
}

export interface PersistedLmStudioProviderConfig
  extends PersistedInferenceProviderBase {
  kind: 'lm-studio';
  apiKey: string | null;
}

export type PersistedInferenceProviderConfig =
  | PersistedOpenAiProviderConfig
  | PersistedLmStudioProviderConfig;

export interface PersistedAppSettings {
  theme: ThemeMode;
  inferenceProviders: PersistedInferenceProviderConfig[];
  activeInferenceProviderId: string | null;
}
