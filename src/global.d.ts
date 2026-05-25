import type { LanguageAppApi } from './shared/language-api';

export {};

declare global {
  interface Window {
    languageApp: LanguageAppApi;
  }
}
