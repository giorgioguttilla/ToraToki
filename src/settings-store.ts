import Store from 'electron-store';
import {
  type InferenceProviderKind,
  type JlptLevel,
  type ThemeMode,
  type UserPreferencesSnapshot,
  type UserPreferencesUpdate,
} from './shared/language-api';
import {
  DEFAULT_LM_STUDIO_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  type PersistedInferenceProviderConfig,
  type PersistedLmStudioProviderConfig,
  type PersistedOpenAiProviderConfig,
} from './inference/config';

const STORE_NAME = 'settings';
const OPENAI_PROVIDER_ID = 'builtin-openai';
const LM_STUDIO_PROVIDER_ID = 'builtin-lm-studio';

interface PersistedUserPreferences {
  theme: ThemeMode;
  jlptLevel: JlptLevel;
  activeProviderKind: InferenceProviderKind;
  openai: PersistedOpenAiProviderConfig;
  lmStudio: PersistedLmStudioProviderConfig;
}

const JLPT_LEVELS: JlptLevel[] = ['N5', 'N4', 'N3', 'N2', 'N1'];

const normalizeJlptLevel = (value: unknown): JlptLevel =>
  typeof value === 'string' && JLPT_LEVELS.includes(value as JlptLevel)
    ? (value as JlptLevel)
    : 'N5';

let settingsStore: Store<Record<string, unknown>> | null = null;

type SettingsStoreAdapter = Store<Record<string, unknown>> & {
  get<T = unknown>(key: string): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
};

const trimToNull = (value?: string | null) => {
  const nextValue = value?.trim();
  return nextValue ? nextValue : null;
};

const requireField = (value: string | null | undefined, fallback: string) => {
  const nextValue = value?.trim();
  return nextValue && nextValue.length > 0 ? nextValue : fallback;
};

const normalizeBaseUrl = (value: string | null | undefined, fallback: string) =>
  (trimToNull(value) ?? fallback).replace(/\/+$/, '');

const createDefaultOpenAiPreferences = (
  timestamp: string,
): PersistedOpenAiProviderConfig => ({
  id: OPENAI_PROVIDER_ID,
  kind: 'openai',
  name: 'OpenAI',
  model: 'gpt-4o-mini',
  apiKey: '',
  baseUrl: DEFAULT_OPENAI_BASE_URL,
  organizationId: null,
  projectId: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const createDefaultLmStudioPreferences = (
  timestamp: string,
): PersistedLmStudioProviderConfig => ({
  id: LM_STUDIO_PROVIDER_ID,
  kind: 'lm-studio',
  name: 'LM Studio',
  model: 'local-model',
  apiKey: null,
  baseUrl: DEFAULT_LM_STUDIO_BASE_URL,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const createDefaultPreferences = (): PersistedUserPreferences => {
  const timestamp = new Date().toISOString();

  return {
    theme: 'dark',
    jlptLevel: 'N5',
    activeProviderKind: 'openai',
    openai: createDefaultOpenAiPreferences(timestamp),
    lmStudio: createDefaultLmStudioPreferences(timestamp),
  };
};

const ensureStore = () => {
  if (!settingsStore) {
    throw new Error('Settings store is not initialized.');
  }

  return settingsStore as SettingsStoreAdapter;
};

const normalizeOpenAiPreferences = (
  provider: Partial<PersistedOpenAiProviderConfig> | null | undefined,
) => {
  const timestamp = new Date().toISOString();
  const fallback = createDefaultOpenAiPreferences(timestamp);

  return {
    id: OPENAI_PROVIDER_ID,
    kind: 'openai' as const,
    name: 'OpenAI',
    model: requireField(provider?.model, fallback.model),
    apiKey: typeof provider?.apiKey === 'string' ? provider.apiKey.trim() : '',
    baseUrl: normalizeBaseUrl(provider?.baseUrl, fallback.baseUrl),
    organizationId: trimToNull(provider?.organizationId),
    projectId: trimToNull(provider?.projectId),
    createdAt: provider?.createdAt ?? fallback.createdAt,
    updatedAt: provider?.updatedAt ?? fallback.updatedAt,
  };
};

const normalizeLmStudioPreferences = (
  provider: Partial<PersistedLmStudioProviderConfig> | null | undefined,
) => {
  const timestamp = new Date().toISOString();
  const fallback = createDefaultLmStudioPreferences(timestamp);

  return {
    id: LM_STUDIO_PROVIDER_ID,
    kind: 'lm-studio' as const,
    name: 'LM Studio',
    model: requireField(provider?.model, fallback.model),
    apiKey: trimToNull(provider?.apiKey),
    baseUrl: normalizeBaseUrl(provider?.baseUrl, fallback.baseUrl),
    createdAt: provider?.createdAt ?? fallback.createdAt,
    updatedAt: provider?.updatedAt ?? fallback.updatedAt,
  };
};

const migrateLegacyPreferences = (
  store: SettingsStoreAdapter,
): PersistedUserPreferences | null => {
  const legacyProviders = store.get<
    Array<PersistedOpenAiProviderConfig | PersistedLmStudioProviderConfig>
  >('inferenceProviders');
  const legacyActiveProviderId = store.get<string | null>('activeInferenceProviderId');

  if (!Array.isArray(legacyProviders)) {
    return null;
  }

  const openAiProvider = legacyProviders.find(
    (provider): provider is PersistedOpenAiProviderConfig => provider.kind === 'openai',
  );
  const lmStudioProvider = legacyProviders.find(
    (provider): provider is PersistedLmStudioProviderConfig =>
      provider.kind === 'lm-studio',
  );

  if (!openAiProvider && !lmStudioProvider) {
    return null;
  }

  const activeProviderKind =
    legacyProviders.find((provider) => provider.id === legacyActiveProviderId)?.kind ??
    (openAiProvider ? 'openai' : 'lm-studio');

  return {
    theme: (store.get<ThemeMode>('theme') ?? 'dark') === 'light' ? 'light' : 'dark',
    jlptLevel: normalizeJlptLevel(store.get<unknown>('jlptLevel')),
    activeProviderKind,
    openai: normalizeOpenAiPreferences(openAiProvider),
    lmStudio: normalizeLmStudioPreferences(lmStudioProvider),
  };
};

const persistPreferences = (preferences: PersistedUserPreferences) => {
  const store = ensureStore();

  store.set('theme', preferences.theme);
  store.set('jlptLevel', preferences.jlptLevel);
  store.set('activeProviderKind', preferences.activeProviderKind);
  store.set('openai', preferences.openai);
  store.set('lmStudio', preferences.lmStudio);
  store.delete('furiganaEnabled');
  store.delete('inferenceProviders');
  store.delete('activeInferenceProviderId');
};

const readPersistedPreferences = (): PersistedUserPreferences => {
  const store = ensureStore();
  const legacyPreferences = migrateLegacyPreferences(store);

  if (legacyPreferences) {
    persistPreferences(legacyPreferences);
    return legacyPreferences;
  }

  const storedOpenAi = store.get<Partial<PersistedOpenAiProviderConfig> | null>('openai');
  const storedLmStudio = store.get<Partial<PersistedLmStudioProviderConfig> | null>('lmStudio');

  if (!storedOpenAi && !storedLmStudio) {
    const defaultPreferences = createDefaultPreferences();
    persistPreferences(defaultPreferences);
    return defaultPreferences;
  }

  const activeProviderKind = store.get<InferenceProviderKind>('activeProviderKind');
  const theme = store.get<ThemeMode>('theme');
  const jlptLevel = store.get<unknown>('jlptLevel');

  const nextPreferences: PersistedUserPreferences = {
    theme: theme === 'light' ? 'light' : 'dark',
    jlptLevel: normalizeJlptLevel(jlptLevel),
    activeProviderKind: activeProviderKind === 'lm-studio' ? 'lm-studio' : 'openai',
    openai: normalizeOpenAiPreferences(storedOpenAi),
    lmStudio: normalizeLmStudioPreferences(storedLmStudio),
  };

  persistPreferences(nextPreferences);

  return nextPreferences;
};

const toUserPreferencesSnapshot = (
  preferences: PersistedUserPreferences,
): UserPreferencesSnapshot => ({
  theme: preferences.theme,
  jlptLevel: preferences.jlptLevel,
  activeProviderKind: preferences.activeProviderKind,
  providers: {
    openai: {
      model: preferences.openai.model,
      baseUrl: preferences.openai.baseUrl,
      hasApiKey: preferences.openai.apiKey.trim().length > 0,
      organizationId: preferences.openai.organizationId,
      projectId: preferences.openai.projectId,
    },
    lmStudio: {
      model: preferences.lmStudio.model,
      baseUrl: preferences.lmStudio.baseUrl,
      hasApiKey: Boolean(preferences.lmStudio.apiKey),
    },
  },
});

export const initializeSettingsStore = () => {
  if (settingsStore) {
    return;
  }

  settingsStore = new Store<Record<string, unknown>>({
    name: STORE_NAME,
  });

  readPersistedPreferences();
};

export const getUserPreferences = () =>
  toUserPreferencesSnapshot(readPersistedPreferences());

export const saveUserPreferences = (update: UserPreferencesUpdate) => {
  const currentPreferences = readPersistedPreferences();
  const updatedAt = new Date().toISOString();

  const nextPreferences: PersistedUserPreferences = {
    ...currentPreferences,
    theme:
      update.theme === undefined
        ? currentPreferences.theme
        : update.theme === 'light'
          ? 'light'
          : 'dark',
    jlptLevel:
      update.jlptLevel === undefined
        ? currentPreferences.jlptLevel
        : normalizeJlptLevel(update.jlptLevel),
    activeProviderKind:
      update.activeProviderKind === undefined
        ? currentPreferences.activeProviderKind
        : update.activeProviderKind,
    openai: {
      ...currentPreferences.openai,
      model:
        update.providers?.openai?.model === undefined
          ? currentPreferences.openai.model
          : requireField(update.providers.openai.model, currentPreferences.openai.model),
      baseUrl:
        update.providers?.openai?.baseUrl === undefined
          ? currentPreferences.openai.baseUrl
          : normalizeBaseUrl(
              update.providers.openai.baseUrl,
              currentPreferences.openai.baseUrl,
            ),
      apiKey:
        update.providers?.openai?.apiKey === undefined
          ? currentPreferences.openai.apiKey
          : update.providers.openai.apiKey.trim(),
      organizationId:
        update.providers?.openai?.organizationId === undefined
          ? currentPreferences.openai.organizationId
          : trimToNull(update.providers.openai.organizationId),
      projectId:
        update.providers?.openai?.projectId === undefined
          ? currentPreferences.openai.projectId
          : trimToNull(update.providers.openai.projectId),
      updatedAt,
    },
    lmStudio: {
      ...currentPreferences.lmStudio,
      model:
        update.providers?.lmStudio?.model === undefined
          ? currentPreferences.lmStudio.model
          : requireField(update.providers.lmStudio.model, currentPreferences.lmStudio.model),
      baseUrl:
        update.providers?.lmStudio?.baseUrl === undefined
          ? currentPreferences.lmStudio.baseUrl
          : normalizeBaseUrl(
              update.providers.lmStudio.baseUrl,
              currentPreferences.lmStudio.baseUrl,
            ),
      apiKey:
        update.providers?.lmStudio?.apiKey === undefined
          ? currentPreferences.lmStudio.apiKey
          : trimToNull(update.providers.lmStudio.apiKey),
      updatedAt,
    },
  };

  persistPreferences(nextPreferences);

  return toUserPreferencesSnapshot(nextPreferences);
};

export const getActiveInferenceProviderConfig = (): PersistedInferenceProviderConfig => {
  const preferences = readPersistedPreferences();

  return preferences.activeProviderKind === 'openai'
    ? preferences.openai
    : preferences.lmStudio;
};
