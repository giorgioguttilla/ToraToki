import type { InferenceProvider } from './providers';
import { createInferenceProvider } from './providers';
import { getActiveInferenceProviderConfig } from '../settings-store';

export const getActiveInferenceProvider = (): InferenceProvider | null => {
  const activeConfig = getActiveInferenceProviderConfig();

  return activeConfig ? createInferenceProvider(activeConfig) : null;
};

export const requireActiveInferenceProvider = (): InferenceProvider => {
  const provider = getActiveInferenceProvider();

  if (!provider) {
    throw new Error('No active inference provider is configured.');
  }

  return provider;
};
