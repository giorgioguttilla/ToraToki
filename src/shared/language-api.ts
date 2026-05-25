import type { SrsReviewRating } from './srs-review';

export const IPC_CHANNELS = {
  clearSrsData: 'language:clear-srs-data',
  createChatSession: 'language:create-chat-session',
  createSrsItem: 'language:create-srs-item',
  updateSrsItem: 'language:update-srs-item',
  deleteChatSession: 'language:delete-chat-session',
  deleteSrsItem: 'language:delete-srs-item',
  exportSrsItems: 'language:export-srs-items',
  getChatSession: 'language:get-chat-session',
  getSrsReviewQueue: 'language:get-srs-review-queue',
  listChatSessions: 'language:list-chat-sessions',
  listDueSrsItems: 'language:list-due-srs-items',
  getSrsStats: 'language:get-srs-stats',
  getUserPreferences: 'language:get-user-preferences',
  getDictionaryStatus: 'language:get-dictionary-status',
  inferenceStreamEvent: 'language:inference-stream-event',
  loadKuromojiDictionaryFile: 'language:load-kuromoji-dictionary-file',
  lookupDictionaryEntries: 'language:lookup-dictionary-entries',
  saveChatSession: 'language:save-chat-session',
  saveUserPreferences: 'language:save-user-preferences',
  startInferenceStream: 'language:start-inference-stream',
  submitSrsReview: 'language:submit-srs-review',
} as const;

export type ThemeMode = 'light' | 'dark';
export type InferenceProviderKind = 'openai' | 'lm-studio';
export type JlptLevel = 'N5' | 'N4' | 'N3' | 'N2' | 'N1';

export interface DictionaryStatus {
  state: 'ready' | 'loading' | 'missing' | 'error';
  source: 'jmdict';
  version: string | null;
  dictDate: string | null;
  detail: string | null;
}

export interface AppVersions {
  chrome: string;
  electron: string;
  node: string;
}

export interface DictionaryLookupQuery {
  surfaceForm: string;
  basicForm?: string | null;
  reading?: string | null;
  partOfSpeech?: string | null;
}

export interface DictionaryEntry {
  entSeq: number;
  headword: string;
  reading: string | null;
  meanings: string[];
  partsOfSpeech: string[];
  notes: string[];
  source: 'jmdict';
  matchedForm: string;
}

export interface OpenAiPreferencesSnapshot {
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  organizationId: string | null;
  projectId: string | null;
}

export interface LmStudioPreferencesSnapshot {
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
}

export interface UserPreferencesSnapshot {
  theme: ThemeMode;
  jlptLevel: JlptLevel;
  activeProviderKind: InferenceProviderKind;
  providers: {
    openai: OpenAiPreferencesSnapshot;
    lmStudio: LmStudioPreferencesSnapshot;
  };
}

export interface UserPreferencesUpdate {
  theme?: ThemeMode;
  jlptLevel?: JlptLevel;
  activeProviderKind?: InferenceProviderKind;
  providers?: {
    openai?: {
      model?: string;
      baseUrl?: string | null;
      apiKey?: string;
      organizationId?: string | null;
      projectId?: string | null;
    };
    lmStudio?: {
      model?: string;
      baseUrl?: string | null;
      apiKey?: string | null;
    };
  };
}

export type SrsCategory = 'kanji' | 'vocab' | 'sentence' | 'translate' | 'correction';

export interface SrsItem {
  id: string;
  item: string;
  answer: string;
  category: SrsCategory;
  sourceEntryId: number | null;
  createdTime: string;
  lastUpdatedTime: string;
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview: string | null;
}

export interface CreateSrsItemInput {
  item: string;
  answer: string;
  category: SrsCategory;
  sourceEntryId?: number | null;
}

export interface UpdateSrsItemInput {
  itemId: string;
  item: string;
  answer: string;
}

export interface SrsStats {
  dueNow: number;
  newCards: number;
  totalTracked: number;
}

export interface SrsExportResult {
  filePath: string;
  itemCount: number;
  exportedAt: string;
}

export interface SrsReviewRatingPreview {
  rating: SrsReviewRating;
  due: string;
  scheduledDays: number;
  learningSteps: number;
}

export interface SrsReviewQueue {
  current: SrsItem | null;
  dueCount: number;
  nextDueAt: string | null;
  ratingPreviews: SrsReviewRatingPreview[];
}

export interface ListDueSrsItemsInput {
  categories?: SrsCategory[];
}

export interface DeleteSrsItemResult {
  deletedItemId: string;
  queue: SrsReviewQueue;
}

export interface SubmitSrsReviewInput {
  itemId: string;
  rating: SrsReviewRating;
}

export interface SubmitSrsReviewResult {
  reviewedItem: SrsItem;
  queue: SrsReviewQueue;
}

export interface UpdateSrsItemResult {
  updatedItem: SrsItem;
  queue: SrsReviewQueue;
}

export interface SrsClearResult {
  deletedCount: number;
  deletedLegacyCount: number;
  clearedAt: string;
}

export type ChatMessageRole = 'user' | 'assistant';

export interface ChatMessageCorrectionDetail {
  originalText: string | null;
  correctedText: string;
  explanation: string;
}

export interface ChatMessageCorrection {
  correctedText: string;
  translation: string;
  corrections: ChatMessageCorrectionDetail[];
  generatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  createdAt: string;
  correction?: ChatMessageCorrection | null;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export interface SaveChatSessionInput {
  id: string;
  messages: ChatMessage[];
}

export type InferenceChatRole = 'system' | 'user' | 'assistant';

export interface InferenceChatMessage {
  role: InferenceChatRole;
  content: string;
}

export interface InferenceChatRequest {
  systemPrompt?: string | null;
  contextMessages?: InferenceChatMessage[];
  messages: InferenceChatMessage[];
  temperature?: number | null;
  maxOutputTokens?: number | null;
}

export interface InferenceUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface InferenceChatResult {
  providerId: string;
  providerKind: InferenceProviderKind;
  model: string;
  text: string;
  finishReason: string | null;
  usage: InferenceUsage | null;
}

export type InferenceStreamEvent =
  | {
      type: 'response.started';
      providerId: string;
      providerKind: InferenceProviderKind;
      model: string;
    }
  | {
      type: 'response.delta';
      providerId: string;
      providerKind: InferenceProviderKind;
      model: string;
      delta: string;
    }
  | {
      type: 'response.completed';
      providerId: string;
      providerKind: InferenceProviderKind;
      model: string;
      text: string;
      finishReason: string | null;
      usage: InferenceUsage | null;
    }
  | {
      type: 'response.error';
      message: string;
    };

export interface InferenceStreamStartRequest {
  requestId: string;
  request: InferenceChatRequest;
}

export interface InferenceStreamEventEnvelope {
  requestId: string;
  event: InferenceStreamEvent;
}

export interface LanguageAppApi {
  versions: AppVersions;
  chat: {
    listSessions(): Promise<ChatSessionSummary[]>;
    createSession(): Promise<ChatSession>;
    deleteSession(chatId: string): Promise<void>;
    getSession(chatId: string): Promise<ChatSession | null>;
    saveSession(input: SaveChatSessionInput): Promise<ChatSession>;
  };
  srs: {
    clearData(): Promise<SrsClearResult>;
    createItem(input: CreateSrsItemInput): Promise<SrsItem>;
    deleteItem(itemId: string): Promise<DeleteSrsItemResult>;
    exportItems(): Promise<SrsExportResult>;
    getStats(): Promise<SrsStats>;
    listDueItems(input?: ListDueSrsItemsInput): Promise<SrsItem[]>;
    getReviewQueue(): Promise<SrsReviewQueue>;
    updateItem(input: UpdateSrsItemInput): Promise<UpdateSrsItemResult>;
    submitReview(input: SubmitSrsReviewInput): Promise<SubmitSrsReviewResult>;
  };
  dictionary: {
    getStatus(): Promise<DictionaryStatus>;
    lookupEntries(query: DictionaryLookupQuery): Promise<DictionaryEntry[]>;
  };
  inference: {
    startChatCompletionStream(input: InferenceStreamStartRequest): void;
    onChatCompletionStreamEvent(
      listener: (event: InferenceStreamEventEnvelope) => void,
    ): () => void;
  };
  settings: {
    getPreferences(): Promise<UserPreferencesSnapshot>;
    savePreferences(update: UserPreferencesUpdate): Promise<UserPreferencesSnapshot>;
  };
  kuromoji: {
    loadDictionaryFile(fileName: string): Promise<ArrayBuffer>;
  };
}
