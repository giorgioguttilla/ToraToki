import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ArrowLeft, ChevronDown, LoaderCircle, Plus, Send, Settings2, Trash2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import SrsReviewPage from '@/SrsReviewPage';
import JapaneseFuriganaText from '@/components/JapaneseFuriganaText';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import {
  formatFrequency,
  formatJlptLevel,
  formatKanjiReadings,
  getKanjiDetailsForText,
  type KanjiReference,
} from '@/lib/kanji-reference';
import { analyzeJapaneseText, type ReaderAnalysis, type ReaderToken } from '@/lib/japanese-reader';
import { cn } from '@/lib/utils';
import {
  KEY_TO_REVIEW_RATING,
  ReviewRatingButton,
  formatRelativeDue,
  getSrsReviewPreviewsForItem,
} from '@/srs/review-ui';
import {
  getPreferredDictionarySrsItemText,
  getPreferredSrsItemText,
  getSrsItemMatchTexts,
} from '@/srs/item-text';
import type {
  ChatMessage,
  ChatMessageCorrection,
  ChatSession,
  ChatSessionSummary,
  CreateSrsItemInput,
  DeleteSrsItemResult,
  DictionaryEntry,
  InferenceChatMessage,
  InferenceProviderKind,
  InferenceStreamEventEnvelope,
  JlptLevel,
  SrsClearResult,
  SrsItem,
  SrsReviewQueue,
  SrsStats,
  SubmitSrsReviewInput,
  SubmitSrsReviewResult,
  UpdateSrsItemInput,
  UpdateSrsItemResult,
  ThemeMode,
  UserPreferencesSnapshot,
  UserPreferencesUpdate,
} from '@/shared/language-api';
import {
  SRS_REVIEW_RATINGS,
  SRS_REVIEW_SHORTCUTS,
  getSrsReviewRatingLabel,
  type SrsReviewRating,
} from '@/shared/srs-review';

interface ChatSummary {
  id: string;
  title: string;
  messageCount: number;
}

const EMPTY_SRS_STATS: SrsStats = {
  dueNow: 0,
  newCards: 0,
  totalTracked: 0,
};

interface SrsActionsContextValue {
  createItem: (input: CreateSrsItemInput) => Promise<void>;
}

const SrsActionsContext = createContext<SrsActionsContextValue | null>(null);

interface TokenInspectorTokenSelection {
  kind: 'token';
  sentenceText: string;
  token: ReaderToken;
}

interface TokenInspectorSrsReviewSelection {
  kind: 'srs-review';
  srsItem: SrsItem;
}

type TokenInspectorSelection =
  | TokenInspectorTokenSelection
  | TokenInspectorSrsReviewSelection;

interface TokenInspectorActionsContextValue {
  closeSelection: () => void;
  openSelection: (selection: TokenInspectorSelection, selectionKey: string) => void;
}

interface TokenInspectorSelectionStore {
  getSelectedKey: () => string | null;
  subscribe: (listener: () => void) => () => void;
}

const TokenInspectorActionsContext = createContext<TokenInspectorActionsContextValue | null>(null);
const TokenInspectorSelectionStoreContext = createContext<TokenInspectorSelectionStore | null>(null);

const INPUT_CLASSNAME =
  'mt-1 h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm text-foreground shadow-xs outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10';

const JAPANESE_CHAT_SYSTEM_PROMPT_BASE =
  'you are having a conversation in japanese. respond only in japanese';
const CONVERSATIONAL_CHAT_SYSTEM_PROMPT =
  'Use natural, casual spoken Japanese like a regular person in everyday conversation. Use plain-style endings by default and avoid polite forms (teineigo / desu-masu), honorific-humble keigo, and stiff textbook phrasing unless the user explicitly asks for polite speech. Keep the tone friendly, direct, and conversational, with natural contractions and filler where appropriate.';
const SENTENCE_TRANSLATION_SYSTEM_PROMPT =
  'translate this sentence from japanese to english';
const UTTERANCE_CORRECTION_SYSTEM_PROMPT_BASE = `You are critiquing a Japanese language learner's utterance.

Return only valid JSON. Do not wrap it in markdown fences. Use this exact schema:
{
  "correctedText": "string",
  "translation": "string",
  "corrections": [
    {
      "originalText": "string or null",
      "correctedText": "string",
      "explanation": "string"
    }
  ]
}

Example:
User utterance: 昨日図書館行った。
Response: {"correctedText":"昨日は図書館に行きました。","translation":"I went to the library yesterday.","corrections":[{"originalText":"昨日図書館行った","correctedText":"昨日は図書館に行きました。","explanation":"Added は and に, and changed the verb to a natural polite past form."}]}

If the utterance is already natural, keep correctedText very close to the original, still provide a translation, and return an empty corrections array.`;
const buildUtteranceCorrectionSystemPrompt = (chatTone: ChatTone) =>
  `${UTTERANCE_CORRECTION_SYSTEM_PROMPT_BASE}

The conversation tone is ${chatTone}. Keep your corrections aligned with that register.

If the tone is conversational, prefer natural casual Japanese: plain forms, everyday vocabulary, and no teinei-go unless the input itself clearly calls for it. Avoid over-correcting casual speech into stiff, polite speech.

If the tone is formal, prefer natural polite Japanese: use teinei-go when that is the appropriate best practice, keep the wording polished, and avoid making the result sound too casual.

When explaining corrections, describe them using the target register's best practices.`;
const SENTENCE_BREAK_PATTERN = /[。！？!?]/u;
const CHAT_PANE_MAX_WIDTH = '56rem';
const CHAT_PROMPT_SRS_MIN_ITEMS = 4;
const CHAT_PROMPT_SRS_MAX_ITEMS = 6;
const CHAT_PROMPT_SRS_CATEGORIES: Array<'kanji' | 'vocab'> = ['kanji', 'vocab'];

type ChatTone = 'formal' | 'conversational';

type PromptSrsHighlightKind = 'kanji' | 'vocab';

interface PromptSrsHighlightItem {
  id: string;
  item: string;
  matchTexts: string[];
  category: PromptSrsHighlightKind;
  srsItem: SrsItem;
}

interface PromptSrsHighlightLookup {
  bestItemByText: Map<string, PromptSrsHighlightItem>;
  candidateLengthsByFirstCharacter: Map<string, number[]>;
}

interface ParsedUtteranceCorrection {
  correctedText: string;
  translation: string;
  corrections: Array<{
    originalText: string | null;
    correctedText: string;
    explanation: string;
  }>;
}

interface ParsedUtteranceCorrectionItem {
  originalText?: unknown;
  correctedText: string;
  explanation: string;
}

const isParsedUtteranceCorrectionItem = (
  value: unknown,
): value is ParsedUtteranceCorrectionItem =>
  Boolean(
    value &&
      typeof value === 'object' &&
      'correctedText' in value &&
      typeof value.correctedText === 'string' &&
      'explanation' in value &&
      typeof value.explanation === 'string',
  );

const PROMPT_SRS_HIGHLIGHT_PRIORITY: Record<PromptSrsHighlightKind, number> = {
  vocab: 1,
  kanji: 2,
};

const EMPTY_PROMPT_SRS_HIGHLIGHT_LOOKUP: PromptSrsHighlightLookup = {
  bestItemByText: new Map(),
  candidateLengthsByFirstCharacter: new Map(),
};

const SrsHighlightLookupContext = createContext<PromptSrsHighlightLookup>(
  EMPTY_PROMPT_SRS_HIGHLIGHT_LOOKUP,
);
const readerAnalysisCache = new Map<string, ReaderAnalysis>();
const readerAnalysisPromiseCache = new Map<string, Promise<ReaderAnalysis>>();

const shouldPreferPromptSrsHighlightItem = (
  candidate: PromptSrsHighlightItem | null,
  current: PromptSrsHighlightItem | null,
) => {
  if (!candidate) {
    return false;
  }

  if (!current) {
    return true;
  }

  const priorityDifference =
    PROMPT_SRS_HIGHLIGHT_PRIORITY[candidate.category] -
    PROMPT_SRS_HIGHLIGHT_PRIORITY[current.category];

  if (priorityDifference !== 0) {
    return priorityDifference > 0;
  }

  if (candidate.item.length !== current.item.length) {
    return candidate.item.length > current.item.length;
  }

  return false;
};

const buildJapaneseChatSystemPrompt = (jlptLevel: JlptLevel) =>
  `${JAPANESE_CHAT_SYSTEM_PROMPT_BASE}. respond to the user at a JLPT ${jlptLevel} level.`;

const extractJsonObjectText = (value: string) => {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  const markdownFenceMatch = trimmedValue.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);

  if (markdownFenceMatch?.[1]) {
    return markdownFenceMatch[1].trim();
  }

  const firstBraceIndex = trimmedValue.indexOf('{');
  const lastBraceIndex = trimmedValue.lastIndexOf('}');

  if (firstBraceIndex === -1 || lastBraceIndex === -1 || lastBraceIndex <= firstBraceIndex) {
    return null;
  }

  return trimmedValue.slice(firstBraceIndex, lastBraceIndex + 1);
};

const parseUtteranceCorrectionResponse = (value: string): ParsedUtteranceCorrection | null => {
  const jsonObjectText = extractJsonObjectText(value);

  if (!jsonObjectText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonObjectText) as {
      correctedText?: unknown;
      translation?: unknown;
      corrections?: unknown[];
    };

    if (
      typeof parsed.correctedText !== 'string' ||
      typeof parsed.translation !== 'string' ||
      !Array.isArray(parsed.corrections)
    ) {
      return null;
    }

    const correctedText = parsed.correctedText.trim();
    const translation = parsed.translation.trim();

    if (!correctedText || !translation) {
      return null;
    }

    return {
      correctedText,
      translation,
      corrections: parsed.corrections
        .filter(isParsedUtteranceCorrectionItem)
        .map((correction) => ({
          originalText:
            typeof correction.originalText === 'string' && correction.originalText.trim().length > 0
              ? correction.originalText.trim()
              : null,
          correctedText: correction.correctedText.trim(),
          explanation: correction.explanation.trim(),
        }))
        .filter(
          (correction) => correction.correctedText.length > 0 && correction.explanation.length > 0,
        ),
    };
  } catch {
    return null;
  }
};

const toChatMessageCorrection = (
  value: ParsedUtteranceCorrection,
): ChatMessageCorrection => ({
  correctedText: value.correctedText,
  translation: value.translation,
  corrections: value.corrections,
  generatedAt: new Date().toISOString(),
});

const normalizeReaderAnalysisCacheKey = (text: string) => text.replace(/\r\n?/g, '\n').trim();

const getCachedReaderAnalysis = (text: string) => {
  const cacheKey = normalizeReaderAnalysisCacheKey(text);

  return cacheKey ? readerAnalysisCache.get(cacheKey) ?? null : null;
};

const getReaderAnalysis = (text: string) => {
  const cacheKey = normalizeReaderAnalysisCacheKey(text);

  if (!cacheKey) {
    return Promise.resolve<ReaderAnalysis | null>(null);
  }

  const cachedAnalysis = readerAnalysisCache.get(cacheKey);

  if (cachedAnalysis) {
    return Promise.resolve(cachedAnalysis);
  }

  const cachedPromise = readerAnalysisPromiseCache.get(cacheKey);

  if (cachedPromise) {
    return cachedPromise;
  }

  const nextPromise = analyzeJapaneseText(text)
    .then((analysis) => {
      readerAnalysisCache.set(cacheKey, analysis);

      return analysis;
    })
    .finally(() => {
      readerAnalysisPromiseCache.delete(cacheKey);
    });

  readerAnalysisPromiseCache.set(cacheKey, nextPromise);

  return nextPromise;
};

const normalizePromptSrsHighlightText = (value: string | null | undefined) => {
  const normalizedValue = value?.trim();

  if (!normalizedValue || normalizedValue === '*') {
    return null;
  }

  return normalizedValue;
};

const normalizePromptSrsHighlightItems = (items: SrsItem[]): PromptSrsHighlightItem[] => {
  const dedupedItems = new Map<string, PromptSrsHighlightItem>();

  for (const item of items) {
    if (item.category !== 'kanji' && item.category !== 'vocab') {
      continue;
    }

    const normalizedItemText = getPreferredSrsItemText(item);
    const matchTexts = getSrsItemMatchTexts(item);

    if (!normalizedItemText || matchTexts.length === 0) {
      continue;
    }

    const dedupeKey = `${item.category}:${normalizedItemText}`;

    if (!dedupedItems.has(dedupeKey)) {
      dedupedItems.set(dedupeKey, {
        id: item.id,
        item: normalizedItemText,
        matchTexts,
        category: item.category,
        srsItem: item,
      });
    }
  }

  return [...dedupedItems.values()].sort((left, right) => {
    const priorityDifference =
      PROMPT_SRS_HIGHLIGHT_PRIORITY[right.category] -
      PROMPT_SRS_HIGHLIGHT_PRIORITY[left.category];

    if (priorityDifference !== 0) {
      return priorityDifference;
    }

    return right.item.length - left.item.length;
  });
};

const buildPromptSrsHighlightLookup = (
  items: PromptSrsHighlightItem[],
): PromptSrsHighlightLookup => {
  if (items.length === 0) {
    return EMPTY_PROMPT_SRS_HIGHLIGHT_LOOKUP;
  }

  const bestItemByText = new Map<string, PromptSrsHighlightItem>();

  for (const item of items) {
    for (const matchText of item.matchTexts) {
      const existingItem = bestItemByText.get(matchText) ?? null;

      if (shouldPreferPromptSrsHighlightItem(item, existingItem)) {
        bestItemByText.set(matchText, item);
      }
    }
  }

  const candidateLengthsByFirstCharacterSets = new Map<string, Set<number>>();

  for (const [itemText] of bestItemByText) {
    const firstCharacter = itemText[0];

    if (!firstCharacter) {
      continue;
    }

    const candidateLengths =
      candidateLengthsByFirstCharacterSets.get(firstCharacter) ?? new Set<number>();

    candidateLengths.add(itemText.length);
    candidateLengthsByFirstCharacterSets.set(firstCharacter, candidateLengths);
  }

  return {
    bestItemByText,
    candidateLengthsByFirstCharacter: new Map(
      [...candidateLengthsByFirstCharacterSets.entries()].map(([firstCharacter, lengths]) => [
        firstCharacter,
        [...lengths].sort((left, right) => right - left),
      ]),
    ),
  };
};

const shuffleValues = <T,>(values: T[]) => {
  const nextValues = [...values];

  for (let index = nextValues.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    const currentValue = nextValues[index];

    nextValues[index] = nextValues[randomIndex];
    nextValues[randomIndex] = currentValue;
  }

  return nextValues;
};

const pickChatPromptSrsItems = (items: SrsItem[]) => {
  const normalizedItems = normalizePromptSrsHighlightItems(items);

  if (normalizedItems.length === 0) {
    return [] as PromptSrsHighlightItem[];
  }

  if (normalizedItems.length <= CHAT_PROMPT_SRS_MIN_ITEMS) {
    return normalizedItems;
  }

  const maxSelectionCount = Math.min(CHAT_PROMPT_SRS_MAX_ITEMS, normalizedItems.length);
  const minSelectionCount = Math.min(CHAT_PROMPT_SRS_MIN_ITEMS, maxSelectionCount);
  const selectionCount =
    minSelectionCount === maxSelectionCount
      ? maxSelectionCount
      : minSelectionCount + Math.floor(Math.random() * (maxSelectionCount - minSelectionCount + 1));

  return shuffleValues(normalizedItems).slice(0, selectionCount);
};

const buildChatTurnSrsPromptInstruction = (items: PromptSrsHighlightItem[]) => {
  if (items.length === 0) {
    return null;
  }

  const kanjiItems = items
    .filter((item) => item.category === 'kanji')
    .map((item) => item.item);
  const vocabItems = items
    .filter((item) => item.category === 'vocab')
    .map((item) => item.item);
  const instructions = [
    'If it fits naturally in your reply, try to incorporate these active SRS review targets.',
  ];

  if (kanjiItems.length > 0) {
    instructions.push(`Use these kanji if possible: ${kanjiItems.join('、')}.`);
  }

  if (vocabItems.length > 0) {
    instructions.push(`Use these vocabulary words if possible: ${vocabItems.join('、')}.`);
  }

  instructions.push('Keep the response natural and do not force awkward wording.');

  return instructions.join(' ');
};

const getBestDirectPromptSrsHighlightForToken = (
  token: ReaderToken,
  highlightLookup: PromptSrsHighlightLookup,
) => {
  let bestHighlight: PromptSrsHighlightItem | null = null;
  const candidateTexts = [
    normalizePromptSrsHighlightText(token.surface),
    normalizePromptSrsHighlightText(token.basicForm),
  ];

  for (const candidateText of candidateTexts) {
    if (!candidateText) {
      continue;
    }

    const candidateHighlight = highlightLookup.bestItemByText.get(candidateText) ?? null;

    if (shouldPreferPromptSrsHighlightItem(candidateHighlight, bestHighlight)) {
      bestHighlight = candidateHighlight;
    }
  }

  return bestHighlight;
};

const buildPromptHighlightSelectionsForLine = (
  line: ReaderToken[],
  highlightLookup: PromptSrsHighlightLookup,
): Array<PromptSrsHighlightItem | null> => {
  if (
    line.length === 0 ||
    highlightLookup.bestItemByText.size === 0 ||
    highlightLookup.candidateLengthsByFirstCharacter.size === 0
  ) {
    return new Array<PromptSrsHighlightItem | null>(line.length).fill(null);
  }

  const lineText = line.map((token) => token.surface).join('');

  if (!lineText) {
    return new Array<PromptSrsHighlightItem | null>(line.length).fill(null);
  }

  const characterHighlights = new Array<PromptSrsHighlightItem | null>(lineText.length).fill(null);

  for (let startIndex = 0; startIndex < lineText.length; startIndex += 1) {
    const candidateLengths =
      highlightLookup.candidateLengthsByFirstCharacter.get(lineText[startIndex] ?? '') ?? null;

    if (!candidateLengths) {
      continue;
    }

    for (const candidateLength of candidateLengths) {
      const endIndex = startIndex + candidateLength;

      if (endIndex > lineText.length) {
        continue;
      }

      const candidateText = lineText.slice(startIndex, endIndex);
      const candidateHighlight = highlightLookup.bestItemByText.get(candidateText) ?? null;

      if (!candidateHighlight) {
        continue;
      }

      for (let index = startIndex; index < endIndex; index += 1) {
        const currentHighlight = characterHighlights[index] ?? null;

        if (shouldPreferPromptSrsHighlightItem(candidateHighlight, currentHighlight)) {
          characterHighlights[index] = candidateHighlight;
        }
      }
    }
  }

  return line.map((token) => {
    let bestHighlight = getBestDirectPromptSrsHighlightForToken(token, highlightLookup);

    for (let index = token.startOffset; index < token.endOffset; index += 1) {
      const characterHighlight = characterHighlights[index] ?? null;

      if (shouldPreferPromptSrsHighlightItem(characterHighlight, bestHighlight)) {
        bestHighlight = characterHighlight;
      }
    }

    return bestHighlight;
  });
};

const toChatSummary = (session: ChatSession | ChatSessionSummary): ChatSummary => {
  if ('messages' in session) {
    return {
      id: session.id,
      title: session.title,
      messageCount: session.messages.length,
    };
  }

  return {
    id: session.id,
    title: session.title,
    messageCount: session.messageCount,
  };
};

const upsertSummary = (summaries: ChatSummary[], summary: ChatSummary) => [
  summary,
  ...summaries.filter((item) => item.id !== summary.id),
];

const toErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const joinSrsAnswerLines = (lines: Array<string | null | undefined>) =>
  lines.filter((line): line is string => Boolean(line && line.trim().length > 0)).join('\n');

const extractSentenceContextText = (children: ReactNode): string =>
  Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') {
        return String(child);
      }

      if (!isValidElement<{ children?: ReactNode }>(child)) {
        return '';
      }

      if (typeof child.type === 'string' && (child.type === 'code' || child.type === 'pre')) {
        return '';
      }

      return child.props.children === undefined
        ? ''
        : extractSentenceContextText(child.props.children);
    })
    .join('');

const buildSentenceRangesForText = (text: string) => {
  const trimmedText = text.trim();

  if (!trimmedText) {
    return [] as Array<{ start: number; end: number }>;
  }

  const sentenceRanges: Array<{ start: number; end: number }> = [];
  let segmentStartIndex = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (!SENTENCE_BREAK_PATTERN.test(text[index] ?? '')) {
      continue;
    }

    sentenceRanges.push({
      start: segmentStartIndex,
      end: index + 1,
    });
    segmentStartIndex = index + 1;
  }

  if (segmentStartIndex < text.length) {
    sentenceRanges.push({
      start: segmentStartIndex,
      end: text.length,
    });
  }

  return sentenceRanges.filter((range) => text.slice(range.start, range.end).trim().length > 0);
};

const getSentenceTextsForLine = (line: ReaderToken[]) => {
  if (line.length === 0) {
    return [] as string[];
  }

  const fullLineText = line.map((token) => token.surface).join('').trim();
  const sentenceTexts = new Array<string>(line.length).fill(fullLineText);
  let segmentStartIndex = 0;

  const assignSegment = (endIndexInclusive: number) => {
    if (endIndexInclusive < segmentStartIndex) {
      return;
    }

    const sentenceText =
      line
        .slice(segmentStartIndex, endIndexInclusive + 1)
        .map((token) => token.surface)
        .join('')
        .trim() || fullLineText;

    for (let index = segmentStartIndex; index <= endIndexInclusive; index += 1) {
      sentenceTexts[index] = sentenceText;
    }

    segmentStartIndex = endIndexInclusive + 1;
  };

  line.forEach((token, tokenIndex) => {
    if (SENTENCE_BREAK_PATTERN.test(token.surface)) {
      assignSegment(tokenIndex);
    }
  });

  assignSegment(line.length - 1);

  return sentenceTexts;
};

const getSentenceTextsForLineFromContext = ({
  line,
  sentenceContextRanges,
  sentenceContextStartOffset,
  sentenceContextText,
}: {
  line: ReaderToken[];
  sentenceContextRanges: Array<{ start: number; end: number }>;
  sentenceContextStartOffset: number;
  sentenceContextText: string;
}) => {
  if (line.length === 0 || sentenceContextRanges.length === 0 || !sentenceContextText.trim()) {
    return getSentenceTextsForLine(line);
  }

  return line.map((token) => {
    const absoluteTokenStart = sentenceContextStartOffset + token.startOffset;
    const sentenceRange = sentenceContextRanges.find(
      (range) => absoluteTokenStart >= range.start && absoluteTokenStart < range.end,
    );

    if (!sentenceRange) {
      return sentenceContextText.trim();
    }

    return sentenceContextText.slice(sentenceRange.start, sentenceRange.end).trim() || sentenceContextText.trim();
  });
};

const createTextSelectionPrefix = (text: string) => {
  let hash = 0;

  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }

  return `${text.length}:${Math.abs(hash)}`;
};

const buildDefinitionSrsInput = (
  token: ReaderToken,
  definition: DictionaryEntry,
): CreateSrsItemInput => {
  const item = getPreferredDictionarySrsItemText({
    definition,
    fallbackText: token.surface,
  });

  return {
    item,
    answer:
      joinSrsAnswerLines([
        definition.reading ? `Reading: ${definition.reading}` : null,
        definition.meanings.length > 0
          ? `Meanings: ${definition.meanings.join(' • ')}`
          : null,
        definition.partsOfSpeech.length > 0
          ? `POS: ${definition.partsOfSpeech.join(' • ')}`
          : null,
        definition.notes.length > 0
          ? `Notes: ${definition.notes.join(' • ')}`
          : null,
      ]) || 'No dictionary gloss available.',
    category: 'vocab',
    sourceEntryId: definition.entSeq,
  };
};

const buildKanjiSrsInput = (kanji: KanjiReference): CreateSrsItemInput => ({
  item: kanji.literal,
  answer:
    joinSrsAnswerLines([
      kanji.meanings.length > 0 ? `Meanings: ${kanji.meanings.join(' • ')}` : null,
      kanji.onyomi.length > 0 ? `Onyomi: ${kanji.onyomi.join('、')}` : null,
      kanji.kunyomi.length > 0 ? `Kunyomi: ${kanji.kunyomi.join('、')}` : null,
      kanji.jlpt ? `JLPT: N${kanji.jlpt}` : null,
      kanji.freq ? `Frequency: #${kanji.freq}` : null,
    ]) || 'No kanji reference data available.',
  category: 'kanji',
});

const buildCorrectionSrsInput = (message: ChatMessage): CreateSrsItemInput | null => {
  if (!message.correction) {
    return null;
  }

  return {
    item: message.content,
    answer:
      joinSrsAnswerLines([
        `Corrected: ${message.correction.correctedText}`,
        `Translation: ${message.correction.translation}`,
        message.correction.corrections.length > 0 ? 'Corrections:' : null,
        ...message.correction.corrections.map((correction, index) => {
          const correctionPrefix = correction.originalText
            ? `${correction.originalText} → ${correction.correctedText}`
            : correction.correctedText;

          return `${index + 1}. ${correctionPrefix} — ${correction.explanation}`;
        }),
      ]) || message.correction.correctedText,
    category: 'correction',
  };
};

const useSrsActions = () => useContext(SrsActionsContext);
const useTokenInspectorActions = () => useContext(TokenInspectorActionsContext);
const useIsTokenSelected = (selectionKey: string) => {
  const selectionStore = useContext(TokenInspectorSelectionStoreContext);

  return useSyncExternalStore(
    selectionStore?.subscribe ?? (() => () => undefined),
    () => selectionStore?.getSelectedKey() === selectionKey,
    () => false,
  );
};

export default function ChatLandingApp() {
  const [preferences, setPreferences] = useState<UserPreferencesSnapshot | null>(null);
  const [isLoadingPreferences, setIsLoadingPreferences] = useState(true);
  const [isSavingPreferences, setIsSavingPreferences] = useState(false);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [isSettingsPageOpen, setIsSettingsPageOpen] = useState(false);
  const [isSrsReviewPageOpen, setIsSrsReviewPageOpen] = useState(false);

  const [chatSummaries, setChatSummaries] = useState<ChatSummary[]>([]);
  const [isLoadingChats, setIsLoadingChats] = useState(false);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [pendingDeleteChatId, setPendingDeleteChatId] = useState<string | null>(null);
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);

  const [activeChat, setActiveChat] = useState<ChatSession | null>(null);
  const [isChatPageOpen, setIsChatPageOpen] = useState(false);
  const [isLoadingActiveChat, setIsLoadingActiveChat] = useState(false);
  const [chatComposerValue, setChatComposerValue] = useState('');
  const [chatError, setChatError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCorrectionStreaming, setIsCorrectionStreaming] = useState(false);
  const [chatTone, setChatTone] = useState<ChatTone>('formal');
  const [srsStats, setSrsStats] = useState<SrsStats>(EMPTY_SRS_STATS);
  const [isLoadingSrsStats, setIsLoadingSrsStats] = useState(false);
  const [srsStatsError, setSrsStatsError] = useState<string | null>(null);
  const [activeDueChatSrsItems, setActiveDueChatSrsItems] = useState<SrsItem[]>([]);

  const isActiveChatBusy = isStreaming || isCorrectionStreaming || isLoadingActiveChat;
  const isLandingPageOpen =
    !isSettingsPageOpen &&
    !isSrsReviewPageOpen &&
    !isChatPageOpen;

  const activeDueChatSrsHighlightItems = useMemo(
    () => normalizePromptSrsHighlightItems(activeDueChatSrsItems),
    [activeDueChatSrsItems],
  );
  const activeDueChatSrsHighlightLookup = useMemo(
    () => buildPromptSrsHighlightLookup(activeDueChatSrsHighlightItems),
    [activeDueChatSrsHighlightItems],
  );

  const activeStreamRequestRef = useRef<string | null>(null);
  const activeStreamChatIdRef = useRef<string | null>(null);
  const activeStreamMessagesRef = useRef<ChatMessage[]>([]);
  const activeChatMessagesRef = useRef<ChatMessage[]>([]);
  const activeCorrectionRequestRef = useRef<{
    requestId: string;
    chatId: string;
    messageId: string;
    responseText: string;
  } | null>(null);
  const activeChatIdRef = useRef<string | null>(null);
  const chatSessionCacheRef = useRef(new Map<string, ChatSession>());
  const chatSaveQueueRef = useRef(Promise.resolve());

  const cacheChatSession = useCallback((session: ChatSession) => {
    chatSessionCacheRef.current.set(session.id, session);
    activeChatMessagesRef.current = session.messages;
  }, []);

  useEffect(() => {
    activeChatIdRef.current = activeChat?.id ?? null;
  }, [activeChat?.id]);

  useEffect(() => {
    activeChatMessagesRef.current = activeChat?.messages ?? [];
  }, [activeChat?.messages]);

  useEffect(() => {
    if (activeChat) {
      cacheChatSession(activeChat);
    }
  }, [activeChat, cacheChatSession]);

  useEffect(() => {
    document.documentElement.classList.toggle(
      'dark',
      (preferences?.theme ?? 'dark') === 'dark',
    );
  }, [preferences?.theme]);

  const loadPreferences = useCallback(async () => {
    setIsLoadingPreferences(true);
    setPreferencesError(null);

    try {
      const snapshot = await window.languageApp.settings.getPreferences();
      setPreferences(snapshot);
    } catch (error) {
      setPreferencesError(
        error instanceof Error
          ? error.message
          : 'Unable to load user preferences.',
      );
    } finally {
      setIsLoadingPreferences(false);
    }
  }, []);

  const loadChatSummaries = useCallback(async () => {
    setIsLoadingChats(true);
    setChatsError(null);

    try {
      const summaries = await window.languageApp.chat.listSessions();
      setChatSummaries(summaries.map(toChatSummary));
    } catch (error) {
      setChatsError(
        error instanceof Error
          ? error.message
          : 'Unable to load chats.',
      );
    } finally {
      setIsLoadingChats(false);
    }
  }, []);

  const loadSrsStats = useCallback(async () => {
    setIsLoadingSrsStats(true);
    setSrsStatsError(null);

    try {
      const stats = await window.languageApp.srs.getStats();
      setSrsStats(stats);
    } catch (error) {
      setSrsStatsError(
        toErrorMessage(error, 'Unable to load SRS stats.'),
      );
    } finally {
      setIsLoadingSrsStats(false);
    }
  }, []);

  const loadActiveDueChatSrsItems = useCallback(async () => {
    try {
      const dueItems = await window.languageApp.srs.listDueItems({
        categories: CHAT_PROMPT_SRS_CATEGORIES,
      });

      setActiveDueChatSrsItems(dueItems);

      return dueItems;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void loadPreferences();
    void loadChatSummaries();
    void loadSrsStats();
    void loadActiveDueChatSrsItems();
  }, [loadPreferences, loadChatSummaries, loadSrsStats, loadActiveDueChatSrsItems]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadActiveDueChatSrsItems();
      }
    }, 60_000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadActiveDueChatSrsItems();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadActiveDueChatSrsItems]);

  useEffect(() => {
    if (!isLandingPageOpen) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadSrsStats();
      }
    }, 60_000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void loadSrsStats();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isLandingPageOpen, loadSrsStats]);

  const runPreferenceSave = useCallback(
    async (update: UserPreferencesUpdate) => {
      setIsSavingPreferences(true);
      setPreferencesError(null);

      try {
        const snapshot = await window.languageApp.settings.savePreferences(update);
        setPreferences(snapshot);
      } catch (error) {
        setPreferencesError(
          error instanceof Error
            ? error.message
            : 'Unable to save user preferences.',
        );
      } finally {
        setIsSavingPreferences(false);
      }
    },
    [],
  );

  const handleThemeChange = useCallback(
    async (theme: ThemeMode) => {
      await runPreferenceSave({ theme });
    },
    [runPreferenceSave],
  );

  const handleJlptLevelChange = useCallback(
    async (jlptLevel: JlptLevel) => {
      setPreferences((current) =>
        current
          ? {
              ...current,
              jlptLevel,
            }
          : current,
      );

      await runPreferenceSave({ jlptLevel });
    },
    [runPreferenceSave],
  );

  const handleActiveProviderKindChange = useCallback(
    async (kind: InferenceProviderKind) => {
      await runPreferenceSave({ activeProviderKind: kind });
    },
    [runPreferenceSave],
  );

  const handleSaveProviderPreferences = useCallback(
    async (update: UserPreferencesUpdate) => {
      await runPreferenceSave(update);
    },
    [runPreferenceSave],
  );

  const handleOpenChat = useCallback(async (chatId: string) => {
    setIsLoadingActiveChat(true);
    setChatError(null);
    setPendingDeleteChatId(null);
    setIsSrsReviewPageOpen(false);

    try {
      await chatSaveQueueRef.current.catch((): void => undefined);

      const session = await window.languageApp.chat.getSession(chatId);
      const cachedSession = chatSessionCacheRef.current.get(chatId) ?? null;
      const resolvedSession = cachedSession ?? session;

      if (!resolvedSession) {
        setChatError('The selected chat could not be found.');
        return;
      }

      cacheChatSession(resolvedSession);
      setActiveChat(resolvedSession);
      setIsChatPageOpen(true);
    } catch (error) {
      setChatError(
        error instanceof Error
          ? error.message
          : 'Unable to load the selected chat.',
      );
    } finally {
      setIsLoadingActiveChat(false);
    }
  }, [cacheChatSession]);

  const handleCreateChat = useCallback(async () => {
    if (isLoadingPreferences || isLoadingChats) {
      return;
    }

    setIsLoadingActiveChat(true);
    setChatError(null);
    setPendingDeleteChatId(null);
    setIsSrsReviewPageOpen(false);

    try {
      const createdChat = await window.languageApp.chat.createSession();
      cacheChatSession(createdChat);
      setActiveChat(createdChat);
      setChatSummaries((current) => upsertSummary(current, toChatSummary(createdChat)));
      setIsChatPageOpen(true);
    } catch (error) {
      setChatError(
        error instanceof Error
          ? error.message
          : 'Unable to create chat.',
      );
    } finally {
      setIsLoadingActiveChat(false);
    }
  }, [cacheChatSession, isLoadingChats, isLoadingPreferences]);

  const handleDeleteChat = useCallback(
    async (chatId: string) => {
      if (deletingChatId) {
        return;
      }

      if ((isStreaming || isCorrectionStreaming) && activeChat?.id === chatId) {
        setChatsError('Wait for the current turn to finish before deleting this chat.');
        return;
      }

      setDeletingChatId(chatId);
      setChatsError(null);

      try {
        await window.languageApp.chat.deleteSession(chatId);
        chatSessionCacheRef.current.delete(chatId);
        setChatSummaries((current) => current.filter((chat) => chat.id !== chatId));

        if (activeChat?.id === chatId) {
          setActiveChat(null);
          setIsChatPageOpen(false);
          setChatComposerValue('');
          setChatError(null);
        }

        setPendingDeleteChatId((current) => (current === chatId ? null : current));
      } catch (error) {
        setChatsError(toErrorMessage(error, 'Unable to delete chat.'));
      } finally {
        setDeletingChatId(null);
      }
    },
    [activeChat?.id, deletingChatId, isCorrectionStreaming, isStreaming],
  );

  const updateStreamingMessages = useCallback((messages: ChatMessage[]) => {
    const streamChatId = activeStreamChatIdRef.current;

    if (!streamChatId) {
      return;
    }

    activeStreamMessagesRef.current = messages;
    activeChatMessagesRef.current = messages;

    setActiveChat((current) =>
      current && current.id === streamChatId
        ? (() => {
            const nextChat = {
              ...current,
              messages,
              updatedAt: new Date().toISOString(),
            };

            cacheChatSession(nextChat);

            return nextChat;
          })()
        : current,
    );
  }, [cacheChatSession]);

  const updateStreamingMessageById = useCallback(
    (messageId: string, updater: (message: ChatMessage) => ChatMessage) => {
      const streamChatId = activeStreamChatIdRef.current;

      if (!streamChatId) {
        return null;
      }

      const currentMessages = activeStreamMessagesRef.current;
      let didUpdateMessage = false;
      const nextMessages = currentMessages.map((message) => {
        if (message.id !== messageId) {
          return message;
        }

        didUpdateMessage = true;

        return updater(message);
      });

      if (!didUpdateMessage) {
        return null;
      }

      updateStreamingMessages(nextMessages);

      return {
        chatId: streamChatId,
        messages: nextMessages,
      };
    },
    [updateStreamingMessages],
  );

  const queueSaveChatSession = useCallback((chatId: string, fallbackMessages: ChatMessage[]) => {
    chatSaveQueueRef.current = chatSaveQueueRef.current
      .catch((): void => undefined)
      .then(async () => {
        const messagesToSave =
          activeStreamChatIdRef.current === chatId && activeStreamMessagesRef.current.length > 0
            ? activeStreamMessagesRef.current
            : activeChatIdRef.current === chatId && activeChatMessagesRef.current.length > 0
              ? activeChatMessagesRef.current
              : fallbackMessages;

        const savedSession = await window.languageApp.chat.saveSession({
          id: chatId,
          messages: messagesToSave,
        });

        setActiveChat((current) =>
          current && current.id === chatId
            ? (() => {
                const nextChat = {
                  ...savedSession,
                  messages: current.messages,
                };

                cacheChatSession(nextChat);

                return nextChat;
              })()
            : current,
        );
        setChatSummaries((current) => upsertSummary(current, toChatSummary(savedSession)));
      })
      .catch((error) => {
        if (activeChatIdRef.current === chatId) {
          setChatError(
            error instanceof Error
              ? error.message
              : 'Unable to persist chat history.',
          );
        }
      });

    return chatSaveQueueRef.current;
  }, [cacheChatSession]);

  const clearTurnStateIfIdle = useCallback(() => {
    if (activeStreamRequestRef.current || activeCorrectionRequestRef.current) {
      return;
    }

    activeStreamChatIdRef.current = null;
    activeStreamMessagesRef.current = [];
  }, []);

  const handleInferenceStreamEvent = useCallback(
    async (payload: InferenceStreamEventEnvelope) => {
      const { event } = payload;

      if (activeCorrectionRequestRef.current?.requestId === payload.requestId) {
        if (event.type === 'response.started') {
          return;
        }

        if (event.type === 'response.delta') {
          activeCorrectionRequestRef.current = {
            ...activeCorrectionRequestRef.current,
            responseText: activeCorrectionRequestRef.current.responseText + event.delta,
          };
          return;
        }

        if (event.type === 'response.error') {
          activeCorrectionRequestRef.current = null;
          setIsCorrectionStreaming(false);
          clearTurnStateIfIdle();
          return;
        }

        const correctionRequest = activeCorrectionRequestRef.current;

        if (!correctionRequest) {
          return;
        }

        const parsedCorrection = parseUtteranceCorrectionResponse(event.text);

        activeCorrectionRequestRef.current = null;
        setIsCorrectionStreaming(false);

        if (!parsedCorrection) {
          clearTurnStateIfIdle();
          return;
        }

        const updatedState = updateStreamingMessageById(correctionRequest.messageId, (message) => ({
          ...message,
          correction: toChatMessageCorrection(parsedCorrection),
        }));

        if (updatedState) {
          void queueSaveChatSession(updatedState.chatId, updatedState.messages);
        }

        clearTurnStateIfIdle();
        return;
      }

      if (!activeStreamRequestRef.current || payload.requestId !== activeStreamRequestRef.current) {
        return;
      }

      const streamChatId = activeStreamChatIdRef.current;

      if (!streamChatId) {
        return;
      }

      if (event.type === 'response.started') {
        return;
      }

      if (event.type === 'response.delta') {
        const currentMessages = activeStreamMessagesRef.current;

        if (currentMessages.length === 0) {
          return;
        }

        const lastMessage = currentMessages.at(-1);

        if (!lastMessage || lastMessage.role !== 'assistant') {
          return;
        }

        const nextMessages = [
          ...currentMessages.slice(0, -1),
          {
            ...lastMessage,
            content: lastMessage.content + event.delta,
          },
        ];

        updateStreamingMessages(nextMessages);
        return;
      }

      if (event.type === 'response.error') {
        const currentMessages = activeStreamMessagesRef.current;
        const lastMessage = currentMessages.at(-1);

        if (lastMessage?.role === 'assistant' && lastMessage.content.length === 0) {
          const nextMessages = currentMessages.slice(0, -1);

          updateStreamingMessages(nextMessages);
          void queueSaveChatSession(streamChatId, nextMessages);
        }

        activeStreamRequestRef.current = null;
        setIsStreaming(false);
        setChatError(event.message);
        clearTurnStateIfIdle();
        return;
      }

      const currentMessages = activeStreamMessagesRef.current;
      const lastMessage = currentMessages.at(-1);

      if (!lastMessage || lastMessage.role !== 'assistant') {
        activeStreamRequestRef.current = null;
        setIsStreaming(false);
        clearTurnStateIfIdle();
        return;
      }

      const completedMessages = [
        ...currentMessages.slice(0, -1),
        {
          ...lastMessage,
          content: event.text,
        },
      ];

      updateStreamingMessages(completedMessages);
      activeStreamRequestRef.current = null;
      setIsStreaming(false);

      void queueSaveChatSession(streamChatId, completedMessages);
      clearTurnStateIfIdle();
    },
    [clearTurnStateIfIdle, queueSaveChatSession, updateStreamingMessageById, updateStreamingMessages],
  );

  useEffect(() => {
    const unsubscribe = window.languageApp.inference.onChatCompletionStreamEvent(
      (payload) => {
        void handleInferenceStreamEvent(payload);
      },
    );

    return unsubscribe;
  }, [handleInferenceStreamEvent]);

  const handleSendMessage = useCallback(async () => {
    if (!activeChat || isStreaming || isCorrectionStreaming) {
      return;
    }

    const content = chatComposerValue.trim();

    if (!content) {
      return;
    }

    const userMessageId = window.crypto.randomUUID();
    const userMessage: ChatMessage = {
      id: userMessageId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      correction: null,
    };
    let selectedPromptSrsItems: PromptSrsHighlightItem[] = [];
    let dueSrsItems = activeDueChatSrsItems;

    try {
      const nextDueSrsItems = await window.languageApp.srs.listDueItems({
        categories: CHAT_PROMPT_SRS_CATEGORIES,
      });

      dueSrsItems = nextDueSrsItems;
      setActiveDueChatSrsItems(nextDueSrsItems);
    } catch {
      dueSrsItems = activeDueChatSrsItems;
    }

    selectedPromptSrsItems = pickChatPromptSrsItems(dueSrsItems);

    const srsPromptInstruction = buildChatTurnSrsPromptInstruction(selectedPromptSrsItems);
    const assistantMessage: ChatMessage = {
      id: window.crypto.randomUUID(),
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    };
    const historyForInference: InferenceChatMessage[] = activeChat.messages.map(
      (message) => ({
        role: message.role,
        content: message.content,
      }),
    );
    const nextMessages = [...activeChat.messages, userMessage, assistantMessage];
    const requestId = window.crypto.randomUUID();
    const correctionRequestId = window.crypto.randomUUID();
    const inferenceRequest = {
      systemPrompt: [
        buildJapaneseChatSystemPrompt(preferences?.jlptLevel ?? 'N5'),
        chatTone === 'conversational' ? CONVERSATIONAL_CHAT_SYSTEM_PROMPT : null,
        srsPromptInstruction,
      ]
        .filter((value): value is string => Boolean(value))
        .join('\n\n'),
      contextMessages: historyForInference,
      messages: [{ role: 'user' as const, content }],
    };

    activeStreamMessagesRef.current = nextMessages;
    activeStreamRequestRef.current = requestId;
    activeStreamChatIdRef.current = activeChat.id;
    activeCorrectionRequestRef.current = {
      requestId: correctionRequestId,
      chatId: activeChat.id,
      messageId: userMessageId,
      responseText: '',
    };

    setChatComposerValue('');
    setChatError(null);
    setIsStreaming(true);
    setIsCorrectionStreaming(true);
    setActiveChat((current) =>
      current && current.id === activeChat.id
        ? (() => {
            const nextChat = {
              ...current,
              messages: nextMessages,
              updatedAt: new Date().toISOString(),
            };

            cacheChatSession(nextChat);

            return nextChat;
          })()
        : current,
    );

    console.log('[ToraToki] Chat completion prompt', {
      requestId,
      request: inferenceRequest,
    });

    window.languageApp.inference.startChatCompletionStream({
      requestId,
      request: inferenceRequest,
    });

    window.languageApp.inference.startChatCompletionStream({
      requestId: correctionRequestId,
      request: {
        systemPrompt: buildUtteranceCorrectionSystemPrompt(chatTone),
        messages: [{ role: 'user' as const, content }],
      },
    });
  }, [activeChat, activeDueChatSrsItems, cacheChatSession, chatComposerValue, chatTone, isCorrectionStreaming, isStreaming, preferences?.jlptLevel]);

  const handleBackToLanding = useCallback(() => {
    setIsChatPageOpen(false);
    setChatComposerValue('');
    setChatError(null);
  }, []);

  const handleCreateSrsItem = useCallback(
    async (input: CreateSrsItemInput) => {
      await window.languageApp.srs.createItem(input);
      await Promise.all([loadSrsStats(), loadActiveDueChatSrsItems()]);
    },
    [loadActiveDueChatSrsItems, loadSrsStats],
  );

  const handleClearSrsData = useCallback(async (): Promise<SrsClearResult> => {
    const result = await window.languageApp.srs.clearData();
    setActiveDueChatSrsItems([]);
    await loadSrsStats();

    return result;
  }, [loadSrsStats]);

  const handleLoadSrsReviewQueue = useCallback(async (): Promise<SrsReviewQueue> =>
    window.languageApp.srs.getReviewQueue(), []);

  const handleSubmitSrsReview = useCallback(
    async (input: SubmitSrsReviewInput): Promise<SubmitSrsReviewResult> => {
      const result = await window.languageApp.srs.submitReview(input);
      setActiveDueChatSrsItems((current) =>
        current.filter((item) => item.id !== result.reviewedItem.id),
      );
      await Promise.all([loadSrsStats(), loadActiveDueChatSrsItems()]);

      return result;
    },
    [loadActiveDueChatSrsItems, loadSrsStats],
  );

  const handleDeleteSrsItem = useCallback(
    async (itemId: string): Promise<DeleteSrsItemResult> => {
      const result = await window.languageApp.srs.deleteItem(itemId);
      setActiveDueChatSrsItems((current) =>
        current.filter((item) => item.id !== result.deletedItemId),
      );
      await Promise.all([loadSrsStats(), loadActiveDueChatSrsItems()]);

      return result;
    },
    [loadActiveDueChatSrsItems, loadSrsStats],
  );

  const handleUpdateSrsItem = useCallback(
    async (input: UpdateSrsItemInput): Promise<UpdateSrsItemResult> => {
      const result = await window.languageApp.srs.updateItem(input);
      await Promise.all([loadSrsStats(), loadActiveDueChatSrsItems()]);

      return result;
    },
    [loadActiveDueChatSrsItems, loadSrsStats],
  );

  const handleBackFromSrsReview = useCallback(() => {
    setIsSrsReviewPageOpen(false);
    void loadSrsStats();
    void loadActiveDueChatSrsItems();
  }, [loadActiveDueChatSrsItems, loadSrsStats]);

  const srsActions = useMemo<SrsActionsContextValue>(
    () => ({
      createItem: handleCreateSrsItem,
    }),
    [handleCreateSrsItem],
  );

  if (isSettingsPageOpen) {
    return (
      <SrsActionsContext.Provider value={srsActions}>
        <SettingsPage
          isBusy={isLoadingPreferences || isSavingPreferences}
          errorMessage={preferencesError}
          preferences={preferences}
          onBack={() => setIsSettingsPageOpen(false)}
          onClearSrsData={handleClearSrsData}
          onJlptLevelChange={handleJlptLevelChange}
          onThemeChange={handleThemeChange}
          onActiveProviderKindChange={handleActiveProviderKindChange}
          onSaveProviderPreferences={handleSaveProviderPreferences}
        />
      </SrsActionsContext.Provider>
    );
  }

  if (isSrsReviewPageOpen) {
    return (
      <SrsActionsContext.Provider value={srsActions}>
        <SrsReviewPage
          onBack={handleBackFromSrsReview}
          createItem={handleCreateSrsItem}
          updateItem={handleUpdateSrsItem}
          deleteItem={handleDeleteSrsItem}
          loadReviewQueue={handleLoadSrsReviewQueue}
          submitReview={handleSubmitSrsReview}
        />
      </SrsActionsContext.Provider>
    );
  }

  if (isChatPageOpen && activeChat) {
    return (
      <SrsActionsContext.Provider value={srsActions}>
        <ChatPage
          chat={activeChat}
          activeDueSrsHighlightLookup={activeDueChatSrsHighlightLookup}
          draft={chatComposerValue}
          jlptLevel={preferences?.jlptLevel ?? 'N5'}
          tone={chatTone}
          isBusy={isActiveChatBusy}
          isStreaming={isStreaming}
          isCorrectionStreaming={isCorrectionStreaming}
          errorMessage={chatError}
          onDraftChange={setChatComposerValue}
          onToneChange={setChatTone}
          onSend={handleSendMessage}
          onBack={handleBackToLanding}
          submitSrsReview={handleSubmitSrsReview}
        />
      </SrsActionsContext.Provider>
    );
  }

  return (
    <SrsActionsContext.Provider value={srsActions}>
      <main className="min-h-screen bg-background">
        <div className="mx-auto min-h-screen w-full max-w-3xl border-x border-border/60">
          <div className="flex justify-end border-b border-border/60 px-4 py-3">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open settings"
              onClick={() => setIsSettingsPageOpen(true)}
            >
              <Settings2 className="size-5" />
            </Button>
          </div>

          <div className="space-y-4 px-4 py-4">
            {preferencesError ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {preferencesError}
              </div>
            ) : null}

            {chatsError ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {chatsError}
              </div>
            ) : null}

            {chatError && !isChatPageOpen ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {chatError}
              </div>
            ) : null}

            <SrsReviewCard
              stats={srsStats}
              isLoading={isLoadingSrsStats}
              errorMessage={srsStatsError}
              onStartReview={() => setIsSrsReviewPageOpen(true)}
            />

            <Card className="border-border/60">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle>Chats</CardTitle>
                    <CardDescription>Start a new conversation or resume one.</CardDescription>
                  </div>
                  <Button
                    onClick={() => {
                      void handleCreateChat();
                    }}
                    disabled={isLoadingPreferences || isLoadingChats || isLoadingActiveChat}
                  >
                    <Plus className="mr-2 size-4" />
                    New chat
                  </Button>
                </div>
              </CardHeader>
              <CardContent
                className={cn(
                  'space-y-2',
                  (isLoadingPreferences || isLoadingChats) && 'opacity-50',
                )}
              >
                {isLoadingPreferences || isLoadingChats ? (
                  <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" />
                    Loading chats…
                  </div>
                ) : chatSummaries.length === 0 ? (
                  <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-6 text-sm text-muted-foreground">
                    Chat list is empty.
                  </div>
                ) : (
                  chatSummaries.map((chat) => (
                    <div
                      key={chat.id}
                      className={cn(
                        'group flex items-center gap-2 rounded-xl border border-border/60 bg-background px-2 py-2 transition-colors',
                        pendingDeleteChatId === chat.id
                          ? 'border-destructive/30 bg-destructive/5'
                          : 'hover:bg-muted/30',
                      )}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg px-2 py-1 text-left text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
                        onClick={() => {
                          void handleOpenChat(chat.id);
                        }}
                        disabled={
                          isLoadingActiveChat ||
                          deletingChatId === chat.id ||
                          pendingDeleteChatId === chat.id
                        }
                      >
                        <span className="truncate font-medium text-foreground">{chat.title}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {chat.messageCount} messages
                        </span>
                      </button>

                      {pendingDeleteChatId === chat.id ? (
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-[11px]"
                            onClick={() => {
                              setPendingDeleteChatId(null);
                              setChatsError(null);
                            }}
                            disabled={deletingChatId === chat.id}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            className="h-7 px-2 text-[11px]"
                            onClick={() => {
                              void handleDeleteChat(chat.id);
                            }}
                            disabled={
                              deletingChatId === chat.id ||
                              (isStreaming && activeChat?.id === chat.id)
                            }
                          >
                            {deletingChatId === chat.id ? (
                              <>
                                <LoaderCircle className="mr-1 size-3 animate-spin" />
                                Deleting…
                              </>
                            ) : (
                              <>
                                <Trash2 className="mr-1 size-3" />
                                Delete
                              </>
                            )}
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 rounded-full text-muted-foreground/60 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100"
                          aria-label={`Delete ${chat.title}`}
                          onClick={() => {
                            setPendingDeleteChatId(chat.id);
                            setChatsError(null);
                          }}
                          disabled={isLoadingActiveChat}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </SrsActionsContext.Provider>
  );
}

function ChatPage({
  chat,
  activeDueSrsHighlightLookup,
  draft,
  jlptLevel,
  tone,
  isBusy,
  isStreaming,
  isCorrectionStreaming,
  errorMessage,
  onDraftChange,
  onToneChange,
  onSend,
  onBack,
  submitSrsReview,
}: {
  chat: ChatSession;
  activeDueSrsHighlightLookup: PromptSrsHighlightLookup;
  draft: string;
  jlptLevel: JlptLevel;
  tone: ChatTone;
  isBusy: boolean;
  isStreaming: boolean;
  isCorrectionStreaming: boolean;
  errorMessage: string | null;
  onDraftChange: (value: string) => void;
  onToneChange: (tone: ChatTone) => void;
  onSend: () => void;
  onBack: () => void;
  submitSrsReview: (input: SubmitSrsReviewInput) => Promise<SubmitSrsReviewResult>;
}) {
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const isComposingRef = useRef(false);
  const [selection, setSelection] = useState<TokenInspectorSelection | null>(null);
  const selectedTokenKeyRef = useRef<string | null>(null);
  const selectionListenersRef = useRef(new Set<() => void>());

  const notifySelectionListeners = useCallback(() => {
    selectionListenersRef.current.forEach((listener) => {
      listener();
    });
  }, []);

  const setSelectedTokenKey = useCallback((nextSelectionKey: string | null) => {
    if (selectedTokenKeyRef.current === nextSelectionKey) {
      return;
    }

    selectedTokenKeyRef.current = nextSelectionKey;
    notifySelectionListeners();
  }, [notifySelectionListeners]);

  const tokenInspectorSelectionStore = useMemo<TokenInspectorSelectionStore>(
    () => ({
      getSelectedKey: () => selectedTokenKeyRef.current,
      subscribe: (listener) => {
        selectionListenersRef.current.add(listener);

        return () => {
          selectionListenersRef.current.delete(listener);
        };
      },
    }),
    [],
  );

  const tokenInspectorActions = useMemo<TokenInspectorActionsContextValue>(
    () => ({
      closeSelection: () => {
        setSelection(null);
        setSelectedTokenKey(null);
      },
      openSelection: (nextSelection, selectionKey) => {
        setSelection(nextSelection);
        setSelectedTokenKey(selectionKey);
      },
    }),
    [setSelectedTokenKey],
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    });
  }, [chat.messages, isStreaming]);

  return (
    <TokenInspectorActionsContext.Provider value={tokenInspectorActions}>
      <TokenInspectorSelectionStoreContext.Provider value={tokenInspectorSelectionStore}>
      <main className="h-screen overflow-hidden bg-background">
        <div className="flex h-full w-full items-stretch overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden">
            <div
              className="mx-auto flex h-full w-full min-w-0 flex-col overflow-hidden border-x border-border/60"
              style={{ maxWidth: CHAT_PANE_MAX_WIDTH }}
            >
              <div className="sticky top-0 z-20 flex shrink-0 items-center gap-3 border-b border-border/60 bg-background/95 px-4 py-3 backdrop-blur supports-backdrop-filter:bg-background/80">
                <Button variant="ghost" size="icon" aria-label="Back" onClick={onBack}>
                  <ArrowLeft className="size-5" />
                </Button>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold tracking-tight">{chat.title}</p>
                    <Badge variant="outline">JLPT {jlptLevel}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">Japanese conversation</p>
                </div>

                <div className="ml-auto flex items-center gap-1 rounded-lg border border-border/60 bg-muted/20 p-1">
                  <Button
                    type="button"
                    size="sm"
                    variant={tone === 'formal' ? 'secondary' : 'ghost'}
                    className="h-7 px-2 text-[11px]"
                    onClick={() => {
                      onToneChange('formal');
                    }}
                    disabled={isBusy}
                  >
                    Formal
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={tone === 'conversational' ? 'secondary' : 'ghost'}
                    className="h-7 px-2 text-[11px]"
                    onClick={() => {
                      onToneChange('conversational');
                    }}
                    disabled={isBusy}
                  >
                    Conversational
                  </Button>
                </div>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
                {errorMessage ? (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    {errorMessage}
                  </div>
                ) : null}

                {chat.messages.length === 0 ? (
                  <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                    Send a message to begin this conversation.
                  </div>
                ) : (
                  chat.messages.map((message, index) => (
                    <MemoizedChatMessageBubble
                      key={`${chat.id}:${message.id}:${index}`}
                      activeDueSrsHighlightLookup={activeDueSrsHighlightLookup}
                      message={message}
                    />
                  ))
                )}

                {isStreaming ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <LoaderCircle className="size-3 animate-spin" />
                    Streaming response…
                  </div>
                ) : null}

                {!isStreaming && isCorrectionStreaming ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <LoaderCircle className="size-3 animate-spin" />
                    Finalizing correction…
                  </div>
                ) : null}

                <div ref={messagesEndRef} />
              </div>

              <div className="border-t border-border/60 p-4">
                <div className="rounded-xl border border-border/60 bg-background p-3">
                  <Textarea
                    value={draft}
                    onChange={(event) => onDraftChange(event.target.value)}
                    placeholder="Type your message…"
                    className="min-h-24 border-0 px-0 py-0 focus-visible:ring-0"
                    disabled={isBusy}
                    onCompositionStart={() => {
                      isComposingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                      isComposingRef.current = false;
                    }}
                    onKeyDown={(event) => {
                      const isImeComposing =
                        isComposingRef.current ||
                        event.nativeEvent.isComposing ||
                        event.keyCode === 229;

                      if (event.key === 'Enter' && !event.shiftKey && !isImeComposing) {
                        event.preventDefault();
                        onSend();
                      }
                    }}
                  />
                  <div className="mt-3 flex justify-end">
                    <Button onClick={onSend} disabled={isBusy || draft.trim().length === 0}>
                      <Send className="mr-2 size-4" />
                      Send
                    </Button>
                  </div>
                </div>
              </div>

          </div>
          </div>

          <TokenInspectorSidecar
            selection={selection}
            className="h-screen"
            onClose={tokenInspectorActions.closeSelection}
            submitSrsReview={submitSrsReview}
          />
        </div>
      </main>
      </TokenInspectorSelectionStoreContext.Provider>
    </TokenInspectorActionsContext.Provider>
  );
}

function TokenInspectorSidecar({
  className,
  selection,
  onClose,
  submitSrsReview,
}: {
  className?: string;
  selection: TokenInspectorSelection | null;
  onClose: () => void;
  submitSrsReview: (input: SubmitSrsReviewInput) => Promise<SubmitSrsReviewResult>;
}) {
  return (
    <aside
      className={cn(
        'shrink-0 overflow-hidden bg-background transition-[width,opacity,border-color] duration-300 ease-out',
        selection
          ? 'w-88 border-l border-border/60 opacity-100'
          : 'pointer-events-none w-0 border-l border-l-transparent opacity-0',
        className,
      )}
      aria-hidden={!selection}
    >
      {selection ? (
        selection.kind === 'srs-review' ? (
          <PromptedSrsReviewInspectorPanel
            selection={selection}
            onClose={onClose}
            submitSrsReview={submitSrsReview}
          />
        ) : (
          <TokenReferenceInspectorPanel selection={selection} onClose={onClose} />
        )
      ) : null}
    </aside>
  );
}

function TokenReferenceInspectorPanel({
  selection,
  onClose,
}: {
  selection: TokenInspectorTokenSelection;
  onClose: () => void;
}) {
  const [translationText, setTranslationText] = useState('');
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isSavingSentenceToSrs, setIsSavingSentenceToSrs] = useState(false);
  const [sentenceSrsMessage, setSentenceSrsMessage] = useState<string | null>(null);
  const [isSentenceSrsError, setIsSentenceSrsError] = useState(false);
  const translationRequestIdRef = useRef<string | null>(null);
  const srsActions = useSrsActions();
  const kanjiDetails = useMemo(
    () => getKanjiDetailsForText(selection.token.surface),
    [selection.token.surface],
  );
  const hasTranslation = translationText.trim().length > 0;

  useEffect(() => {
    translationRequestIdRef.current = null;
    setTranslationText('');
    setTranslationError(null);
    setIsTranslating(false);
    setSentenceSrsMessage(null);
    setIsSentenceSrsError(false);
  }, [selection]);

  useEffect(() => {
    const unsubscribe = window.languageApp.inference.onChatCompletionStreamEvent(
      (payload) => {
        if (!translationRequestIdRef.current || payload.requestId !== translationRequestIdRef.current) {
          return;
        }

        const { event } = payload;

        if (event.type === 'response.started') {
          return;
        }

        if (event.type === 'response.delta') {
          setTranslationText((current) => current + event.delta);
          return;
        }

        if (event.type === 'response.error') {
          translationRequestIdRef.current = null;
          setIsTranslating(false);
          setTranslationError(event.message);
          return;
        }

        translationRequestIdRef.current = null;
        setIsTranslating(false);
        setTranslationText(event.text);
      },
    );

    return unsubscribe;
  }, []);

  const handleTranslate = async () => {
    if (isTranslating) {
      return;
    }

    const requestId = window.crypto.randomUUID();

    translationRequestIdRef.current = requestId;
    setTranslationText('');
    setTranslationError(null);
    setSentenceSrsMessage(null);
    setIsTranslating(true);

    window.languageApp.inference.startChatCompletionStream({
      requestId,
      request: {
        systemPrompt: SENTENCE_TRANSLATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: selection.sentenceText }],
      },
    });
  };

  const handleAddSentenceToSrs = async () => {
    if (!srsActions || isSavingSentenceToSrs || !hasTranslation) {
      return;
    }

    setIsSavingSentenceToSrs(true);
    setSentenceSrsMessage(null);
    setIsSentenceSrsError(false);

    try {
      await srsActions.createItem({
        item: selection.sentenceText,
        answer: translationText,
        category: 'sentence',
      });
      setSentenceSrsMessage('Saved sentence to SRS.');
    } catch (error) {
      setIsSentenceSrsError(true);
      setSentenceSrsMessage(
        toErrorMessage(error, 'Unable to save this sentence to SRS.'),
      );
    } finally {
      setIsSavingSentenceToSrs(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div>
          <p className="text-sm font-semibold tracking-tight">Inspector</p>
          <p className="text-xs text-muted-foreground">Token, sentence, and reference details.</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Sentence
          </p>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-foreground">
            {selection.sentenceText}
          </p>
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void handleTranslate();
              }}
              disabled={isTranslating}
            >
              {isTranslating ? (
                <>
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  Translating…
                </>
              ) : (
                'Translate'
              )}
            </Button>
          </div>

          {translationError ? (
            <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {translationError}
            </div>
          ) : null}

          {(isTranslating || hasTranslation) ? (
            <div className="mt-3 rounded-lg border border-border/60 bg-background/80 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Translation
              </p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">
                {translationText || 'Waiting for translation…'}
              </p>

              {!isTranslating && hasTranslation ? (
                <div className="mt-3 space-y-2">
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void handleAddSentenceToSrs();
                      }}
                      disabled={isSavingSentenceToSrs}
                    >
                      {isSavingSentenceToSrs ? (
                        <>
                          <LoaderCircle className="mr-2 size-4 animate-spin" />
                          Saving…
                        </>
                      ) : (
                        'Add sentence to SRS'
                      )}
                    </Button>
                  </div>

                  {sentenceSrsMessage ? (
                    <p
                      className={cn(
                        'text-xs',
                        isSentenceSrsError ? 'text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {sentenceSrsMessage}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Token
          </p>
          <p className="mt-3 text-lg font-semibold leading-tight text-foreground">
            {selection.token.surface}
          </p>
          {selection.token.readingHiragana ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {selection.token.readingHiragana}
            </p>
          ) : null}
          <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
            <span className="text-muted-foreground">Base form</span>
            <span className="text-foreground">{selection.token.basicForm}</span>
            <span className="text-muted-foreground">Part of speech</span>
            <span className="text-foreground">{selection.token.partOfSpeech}</span>
            <span className="text-muted-foreground">Detail</span>
            <span className="text-foreground">{selection.token.partOfSpeechDetail}</span>
          </div>
        </div>

        <DictionaryReferenceSection token={selection.token} />

        {kanjiDetails.length > 0 ? <KanjiReferenceSection kanjiDetails={kanjiDetails} /> : null}
      </div>
    </div>
  );
}

function PromptedSrsReviewInspectorPanel({
  selection,
  onClose,
  submitSrsReview,
}: {
  selection: TokenInspectorSrsReviewSelection;
  onClose: () => void;
  submitSrsReview: (input: SubmitSrsReviewInput) => Promise<SubmitSrsReviewResult>;
}) {
  const [isAnswerVisible, setIsAnswerVisible] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reviewedState, setReviewedState] = useState<{
    rating: SrsReviewRating;
    reviewedItem: SrsItem;
  } | null>(null);
  const displayedSrsItem = reviewedState?.reviewedItem ?? selection.srsItem;
  const displayedSrsPromptText = getPreferredSrsItemText(displayedSrsItem);
  const displayedSrsVocabKanjiDetails = useMemo(
    () => (displayedSrsItem.category === 'vocab' ? getKanjiDetailsForText(displayedSrsItem.item) : []),
    [displayedSrsItem.category, displayedSrsItem.item],
  );
  const ratingPreviews = useMemo(
    () => getSrsReviewPreviewsForItem(selection.srsItem),
    [selection.srsItem],
  );

  useEffect(() => {
    setIsAnswerVisible(false);
    setIsSubmitting(false);
    setErrorMessage(null);
    setReviewedState(null);
  }, [selection.srsItem.id]);

  const handleRevealAnswer = useCallback(() => {
    if (isAnswerVisible || reviewedState) {
      return;
    }

    setIsAnswerVisible(true);
  }, [isAnswerVisible, reviewedState]);

  const handleSubmitRating = useCallback(
    async (rating: SrsReviewRating) => {
      if (!isAnswerVisible || isSubmitting || reviewedState) {
        return;
      }

      setIsSubmitting(true);
      setErrorMessage(null);

      try {
        const result = await submitSrsReview({
          itemId: selection.srsItem.id,
          rating,
        });

        setIsAnswerVisible(true);
        setReviewedState({
          rating,
          reviewedItem: result.reviewedItem,
        });
      } catch (error) {
        setErrorMessage(toErrorMessage(error, 'Unable to submit the SRS review.'));
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      isAnswerVisible,
      isSubmitting,
      reviewedState,
      selection.srsItem.id,
      submitSrsReview,
    ],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;

      if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
        return;
      }

      if (event.code === 'Space') {
        if (isAnswerVisible || reviewedState) {
          return;
        }

        event.preventDefault();
        setIsAnswerVisible(true);
        return;
      }

      if (!isAnswerVisible || isSubmitting || reviewedState) {
        return;
      }

      const rating = KEY_TO_REVIEW_RATING[event.key];

      if (!rating) {
        return;
      }

      event.preventDefault();
      void handleSubmitRating(rating);
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleSubmitRating, isAnswerVisible, isSubmitting, reviewedState]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div>
          <p className="text-sm font-semibold tracking-tight">SRS review</p>
          <p className="text-xs text-muted-foreground">Review this highlighted card inline.</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close SRS review"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex min-h-8 flex-wrap items-center gap-2">
          <Badge variant="outline">Due {formatRelativeDue(displayedSrsItem.due)}</Badge>
          <Badge variant="secondary">{displayedSrsItem.category}</Badge>
          {reviewedState ? (
            <Badge variant="outline">Rated {getSrsReviewRatingLabel(reviewedState.rating)}</Badge>
          ) : null}
        </div>

        {errorMessage ? (
          <div className="shrink-0 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {errorMessage}
          </div>
        ) : null}

        <button
          type="button"
          className={cn(
            'grid min-h-72 w-full shrink-0 grid-rows-[auto_minmax(0,1fr)_auto] rounded-[2rem] border border-border/60 bg-muted/20 px-5 py-5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            !isAnswerVisible && !reviewedState && 'hover:bg-muted/30',
          )}
          onClick={handleRevealAnswer}
          disabled={isSubmitting}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {isAnswerVisible || reviewedState ? 'Answer' : 'Prompt'}
          </p>
          <div className="mt-5 min-h-0 overflow-y-auto whitespace-pre-wrap wrap-break-word text-xl font-semibold leading-9 text-foreground">
            {isAnswerVisible || reviewedState ? (
              displayedSrsItem.category === 'sentence' ? (
                <div className="space-y-4 text-base font-medium leading-8">
                  <p className="whitespace-pre-wrap wrap-break-word text-xl font-semibold leading-9 text-foreground">
                    {displayedSrsItem.answer}
                  </p>

                  <div className="rounded-2xl border border-border/60 bg-background/70 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Japanese sentence
                    </p>
                    <JapaneseFuriganaText
                      text={displayedSrsItem.item}
                      className="mt-3 text-lg font-medium leading-8 text-foreground"
                    />
                  </div>
                </div>
              ) : displayedSrsItem.category === 'kanji' || displayedSrsItem.category === 'vocab' ? (
                <div className="space-y-4 text-base font-medium leading-8">
                  <div className="rounded-2xl border border-border/60 bg-background/70 px-4 py-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Japanese
                    </p>
                    <JapaneseFuriganaText
                      text={displayedSrsItem.item}
                      className="mt-3 text-lg font-medium leading-8 text-foreground"
                    />
                  </div>

                  <p className="whitespace-pre-wrap wrap-break-word text-xl font-semibold leading-9 text-foreground">
                    {displayedSrsItem.answer}
                  </p>

                  {displayedSrsItem.category === 'vocab' && displayedSrsVocabKanjiDetails.length > 0 ? (
                    <div className="rounded-2xl border border-border/60 bg-background/70 px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Key kanji
                      </p>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {displayedSrsVocabKanjiDetails.map((kanji) => (
                          <div key={kanji.literal} className="rounded-xl border border-border/60 bg-background/80 p-3">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-lg font-semibold leading-none text-foreground">{kanji.literal}</p>
                              <p className="text-[11px] text-muted-foreground">{formatJlptLevel(kanji.jlpt)}</p>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {kanji.meanings.length > 0 ? kanji.meanings.slice(0, 3).join(' • ') : '—'}
                            </p>
                            <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                              <span>On</span>
                              <span className="text-foreground">{formatKanjiReadings(kanji.onyomi)}</span>
                              <span>Kun</span>
                              <span className="text-foreground">{formatKanjiReadings(kanji.kunyomi)}</span>
                              <span>Commonality</span>
                              <span className="text-foreground">{formatFrequency(kanji.freq)}</span>
                              <span>JLPT</span>
                              <span className="text-foreground">{formatJlptLevel(kanji.jlpt)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                displayedSrsItem.answer
              )
            ) : (
              displayedSrsPromptText
            )}
          </div>
          <div className="mt-4 flex min-h-6 items-end text-sm text-muted-foreground">
            {!isAnswerVisible && !reviewedState ? (
              <p>Click the card or press Space to reveal the answer.</p>
            ) : reviewedState ? (
              <p>Click another SRS item to review or check definitions.</p>
            ) : (
              <p>Use 1–4 below, or press the number keys, to rate this review.</p>
            )}
          </div>
        </button>

        <div className="rounded-3xl border border-border/60 bg-background/40 p-2">
          {reviewedState ? (
            <div className="flex h-full flex-col justify-between rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
              <div>
                <p className="text-sm font-semibold tracking-tight text-foreground">
                  Review saved as {getSrsReviewRatingLabel(reviewedState.rating)}.
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Next review {formatRelativeDue(reviewedState.reviewedItem.due)}.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Click another SRS item to review or check definitions.
              </p>
            </div>
          ) : isAnswerVisible ? (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                {ratingPreviews.map((preview) => (
                  <ReviewRatingButton
                    className="w-full whitespace-normal"
                    key={preview.rating}
                    disabled={isSubmitting}
                    isSubmitting={isSubmitting}
                    onClick={(rating) => {
                      void handleSubmitRating(rating);
                    }}
                    rating={preview.rating}
                    scheduledDue={preview.due}
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Use 1–4 to rate yourself: {SRS_REVIEW_RATINGS.map((rating) => `${SRS_REVIEW_SHORTCUTS[rating]} ${getSrsReviewRatingLabel(rating)}`).join(' • ')}.
              </p>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-border/60 bg-muted/10 px-4 text-center text-sm text-muted-foreground">
              Reveal the answer to unlock the rating buttons.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatMessageBubble({
  activeDueSrsHighlightLookup,
  message,
}: {
  activeDueSrsHighlightLookup: PromptSrsHighlightLookup;
  message: ChatMessage;
}) {
  const isUserMessage = message.role === 'user';
  const srsActions = useSrsActions();
  const [isCorrectionOpen, setIsCorrectionOpen] = useState(false);
  const [isSavingCorrectionCard, setIsSavingCorrectionCard] = useState(false);
  const [correctionCardStatusMessage, setCorrectionCardStatusMessage] = useState<string | null>(null);
  const [isCorrectionCardError, setIsCorrectionCardError] = useState(false);

  useEffect(() => {
    setCorrectionCardStatusMessage(null);
    setIsCorrectionCardError(false);
    setIsSavingCorrectionCard(false);
  }, [message.id, message.correction?.generatedAt]);

  const handleSaveCorrectionCard = useCallback(async () => {
    if (!srsActions || isSavingCorrectionCard) {
      return;
    }

    const srsInput = buildCorrectionSrsInput(message);

    if (!srsInput) {
      return;
    }

    setIsSavingCorrectionCard(true);
    setCorrectionCardStatusMessage(null);
    setIsCorrectionCardError(false);

    try {
      await srsActions.createItem(srsInput);
      setCorrectionCardStatusMessage('Saved correction card to SRS.');
    } catch (error) {
      setIsCorrectionCardError(true);
      setCorrectionCardStatusMessage(
        toErrorMessage(error, 'Unable to save this correction card to SRS.'),
      );
    } finally {
      setIsSavingCorrectionCard(false);
    }
  }, [isSavingCorrectionCard, message, srsActions]);

  return (
    <div className={cn('flex', isUserMessage ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl border px-4 py-3 text-sm leading-7',
          isUserMessage
            ? 'border-primary/30 bg-primary/10 text-foreground'
            : 'border-border/60 bg-muted/20 text-foreground',
        )}
      >
        {isUserMessage ? (
          <div>
            <MemoizedJapaneseRichText
              text={message.content}
              srsHighlightLookup={activeDueSrsHighlightLookup}
            />

            {message.correction ? (
              <div className="mt-3 border-t border-primary/15 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-6 px-1.5 text-[11px] font-medium text-muted-foreground"
                  aria-expanded={isCorrectionOpen}
                  onClick={() => {
                    setIsCorrectionOpen((current) => !current);
                  }}
                >
                  Correction
                  <ChevronDown
                    className={cn(
                      'size-3 transition-transform',
                      isCorrectionOpen ? 'rotate-180' : 'rotate-0',
                    )}
                  />
                </Button>

                {isCorrectionOpen ? (
                  <div className="mt-2 space-y-3 rounded-xl border border-primary/15 bg-background/70 p-3">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Corrected text
                      </p>
                      <div className="mt-2 text-sm leading-7 text-foreground">
                        <MemoizedJapaneseRichText
                          text={message.correction.correctedText}
                          srsHighlightLookup={activeDueSrsHighlightLookup}
                        />
                      </div>
                    </div>

                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Translation
                      </p>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">
                        {message.correction.translation}
                      </p>
                    </div>

                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Notes
                      </p>
                      {message.correction.corrections.length > 0 ? (
                        <ul className="mt-2 space-y-2 text-sm leading-6 text-foreground">
                          {message.correction.corrections.map((correction, index) => (
                            <li key={`${message.id}:correction:${index}`} className="rounded-lg bg-muted/30 px-2.5 py-2">
                              <p className="font-medium text-foreground">
                                {correction.originalText ? (
                                  <>
                                    {correction.originalText} → {correction.correctedText}
                                  </>
                                ) : (
                                  correction.correctedText
                                )}
                              </p>
                              <p className="mt-1 text-muted-foreground">{correction.explanation}</p>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-sm text-muted-foreground">
                          This utterance is already natural with no notable corrections.
                        </p>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          void handleSaveCorrectionCard();
                        }}
                        disabled={!srsActions || isSavingCorrectionCard}
                      >
                        {isSavingCorrectionCard ? (
                          <>
                            <LoaderCircle className="mr-2 size-3.5 animate-spin" />
                            Saving…
                          </>
                        ) : (
                          <>
                            <Plus className="mr-2 size-3.5" />
                            Save correction card
                          </>
                        )}
                      </Button>

                      {correctionCardStatusMessage ? (
                        <p
                          className={cn(
                            'text-xs',
                            isCorrectionCardError ? 'text-destructive' : 'text-muted-foreground',
                          )}
                        >
                          {correctionCardStatusMessage}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <MarkdownJapaneseContent
            markdown={message.content}
            srsHighlightLookup={activeDueSrsHighlightLookup}
          />
        )}
      </div>
    </div>
  );
}

const MemoizedChatMessageBubble = memo(
  ChatMessageBubble,
  (previousProps, nextProps) =>
    previousProps.message === nextProps.message &&
    previousProps.activeDueSrsHighlightLookup === nextProps.activeDueSrsHighlightLookup,
);

const renderMarkdownChildrenWithJapanese = (
  children: ReactNode,
  srsHighlightLookup: PromptSrsHighlightLookup,
  sentenceContextText?: string,
): ReactNode => {
  let sentenceContextOffset = 0;

  const renderChildren = (nextChildren: ReactNode): ReactNode =>
    Children.map(nextChildren, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      const content = String(child);
      const contentOffset = sentenceContextOffset;

      sentenceContextOffset += content.length;

      if (content.trim().length === 0) {
        return content;
      }

      return (
        <MemoizedJapaneseRichText
          text={content}
          inline
          srsHighlightLookup={srsHighlightLookup}
          sentenceContextStartOffset={sentenceContextText ? contentOffset : undefined}
          sentenceContextText={sentenceContextText}
        />
      );
    }

    if (!isValidElement<{ children?: ReactNode }>(child)) {
      return child;
    }

    if (typeof child.type === 'string' && (child.type === 'code' || child.type === 'pre')) {
      return child;
    }

    if (child.props.children === undefined) {
      return child;
    }

    return cloneElement(child, {
      children: renderChildren(child.props.children),
    });
  });
  
  return renderChildren(children);
};

function MarkdownJapaneseChildren({
  children,
  sentenceContextText,
}: {
  children?: ReactNode;
  sentenceContextText?: string;
}) {
  const srsHighlightLookup = useContext(SrsHighlightLookupContext);

  return <>{renderMarkdownChildrenWithJapanese(children, srsHighlightLookup, sentenceContextText)}</>;
}

const MARKDOWN_JAPANESE_COMPONENTS = {
  p: ({ children }: { children?: ReactNode }) => {
    const sentenceContextText = extractSentenceContextText(children);

    return (
    <p className="mb-3 last:mb-0">
      <MarkdownJapaneseChildren sentenceContextText={sentenceContextText}>{children}</MarkdownJapaneseChildren>
    </p>
    );
  },
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="mb-3 list-disc pl-5 last:mb-0">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="mb-3 list-decimal pl-5 last:mb-0">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => {
    const sentenceContextText = extractSentenceContextText(children);

    return (
    <li>
      <MarkdownJapaneseChildren sentenceContextText={sentenceContextText}>{children}</MarkdownJapaneseChildren>
    </li>
    );
  },
  blockquote: ({ children }: { children?: ReactNode }) => {
    const sentenceContextText = extractSentenceContextText(children);

    return (
    <blockquote className="mb-3 border-l-2 border-border/70 pl-3 text-muted-foreground last:mb-0">
      <MarkdownJapaneseChildren sentenceContextText={sentenceContextText}>{children}</MarkdownJapaneseChildren>
    </blockquote>
    );
  },
  h1: ({ children }: { children?: ReactNode }) => {
    const sentenceContextText = extractSentenceContextText(children);

    return (
    <h1 className="mb-2 text-lg font-semibold">
      <MarkdownJapaneseChildren sentenceContextText={sentenceContextText}>{children}</MarkdownJapaneseChildren>
    </h1>
    );
  },
  h2: ({ children }: { children?: ReactNode }) => {
    const sentenceContextText = extractSentenceContextText(children);

    return (
    <h2 className="mb-2 text-base font-semibold">
      <MarkdownJapaneseChildren sentenceContextText={sentenceContextText}>{children}</MarkdownJapaneseChildren>
    </h2>
    );
  },
  h3: ({ children }: { children?: ReactNode }) => {
    const sentenceContextText = extractSentenceContextText(children);

    return (
    <h3 className="mb-2 text-sm font-semibold">
      <MarkdownJapaneseChildren sentenceContextText={sentenceContextText}>{children}</MarkdownJapaneseChildren>
    </h3>
    );
  },
  strong: ({ children }: { children?: ReactNode }) => (
    <strong>
      <MarkdownJapaneseChildren>{children}</MarkdownJapaneseChildren>
    </strong>
  ),
  em: ({ children }: { children?: ReactNode }) => (
    <em>
      <MarkdownJapaneseChildren>{children}</MarkdownJapaneseChildren>
    </em>
  ),
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      <MarkdownJapaneseChildren>{children}</MarkdownJapaneseChildren>
    </a>
  ),
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className="mb-3 overflow-x-auto rounded-md border border-border/60 bg-muted/20 p-3 text-xs last:mb-0">
      {children}
    </pre>
  ),
  code: ({ children }: { children?: ReactNode }) => (
    <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{children}</code>
  ),
};

function MarkdownJapaneseContent({
  markdown,
  srsHighlightLookup = EMPTY_PROMPT_SRS_HIGHLIGHT_LOOKUP,
}: {
  markdown: string;
  srsHighlightLookup?: PromptSrsHighlightLookup;
}) {
  return (
    <SrsHighlightLookupContext.Provider value={srsHighlightLookup}>
      <ReactMarkdown components={MARKDOWN_JAPANESE_COMPONENTS}>
        {markdown}
      </ReactMarkdown>
    </SrsHighlightLookupContext.Provider>
  );
}

function JapaneseRichText({
  text,
  inline = false,
  srsHighlightLookup = EMPTY_PROMPT_SRS_HIGHLIGHT_LOOKUP,
  sentenceContextStartOffset,
  sentenceContextText,
}: {
  text: string;
  inline?: boolean;
  srsHighlightLookup?: PromptSrsHighlightLookup;
  sentenceContextStartOffset?: number;
  sentenceContextText?: string;
}) {
  const normalizedAnalysisCacheKey = useMemo(
    () => normalizeReaderAnalysisCacheKey(text),
    [text],
  );
  const [analysis, setAnalysis] = useState<ReaderAnalysis | null>(() =>
    getCachedReaderAnalysis(text),
  );
  const selectionPrefix = useMemo(() => createTextSelectionPrefix(text), [text]);

  useEffect(() => {
    if (!normalizedAnalysisCacheKey) {
      setAnalysis(null);
      return;
    }

    const cachedAnalysis = readerAnalysisCache.get(normalizedAnalysisCacheKey) ?? null;

    if (cachedAnalysis) {
      setAnalysis(cachedAnalysis);
      return;
    }

    setAnalysis(null);

    let isCancelled = false;

    void getReaderAnalysis(text)
      .then((result) => {
        if (!isCancelled) {
          setAnalysis(result);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setAnalysis(null);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [normalizedAnalysisCacheKey, text]);

  const linePromptHighlightKinds = useMemo(
    () =>
      analysis
        ? analysis.lines.map((line) =>
            buildPromptHighlightSelectionsForLine(line, srsHighlightLookup),
          )
        : [],
    [analysis, srsHighlightLookup],
  );
  const sentenceContextRanges = useMemo(
    () => buildSentenceRangesForText(sentenceContextText ?? ''),
    [sentenceContextText],
  );
  const lineStartOffsets = useMemo(() => {
    if (!analysis) {
      return [] as number[];
    }

    let currentOffset = 0;

    return analysis.lines.map((line, lineIndex) => {
      const startOffset = currentOffset;
      currentOffset += line.reduce((total, token) => total + token.surface.length, 0);

      if (lineIndex < analysis.lines.length - 1) {
        currentOffset += 1;
      }

      return startOffset;
    });
  }, [analysis]);

  if (!analysis || analysis.lines.length === 0) {
    return inline ? (
      <span className="whitespace-pre-wrap wrap-break-word">{text}</span>
    ) : (
      <p className="whitespace-pre-wrap wrap-break-word">{text}</p>
    );
  }

  if (inline) {
    return (
      <span className="whitespace-pre-wrap wrap-break-word">
        {analysis.lines.map((line, lineIndex) => {
          const sentenceTexts =
            sentenceContextText && typeof sentenceContextStartOffset === 'number'
              ? getSentenceTextsForLineFromContext({
                  line,
                  sentenceContextRanges,
                  sentenceContextStartOffset:
                    sentenceContextStartOffset + (lineStartOffsets[lineIndex] ?? 0),
                  sentenceContextText,
                })
              : getSentenceTextsForLine(line);

          return (
            <span key={`${text.slice(0, 8)}:${lineIndex}`} className="leading-7">
              {line.map((token, tokenIndex) => (
                <JapaneseToken
                  key={`${token.surface}:${tokenIndex}`}
                  selectionKey={`${selectionPrefix}:${lineIndex}:${tokenIndex}`}
                  srsHighlight={linePromptHighlightKinds[lineIndex]?.[tokenIndex] ?? null}
                  token={token}
                  sentenceText={sentenceTexts[tokenIndex] ?? text}
                />
              ))}
              {lineIndex < analysis.lines.length - 1 ? <br /> : null}
            </span>
          );
        })}
      </span>
    );
  }

  return (
    <div className="space-y-1 whitespace-pre-wrap wrap-break-word">
      {analysis.lines.map((line, lineIndex) => {
        const sentenceTexts =
          sentenceContextText && typeof sentenceContextStartOffset === 'number'
            ? getSentenceTextsForLineFromContext({
                line,
                sentenceContextRanges,
                sentenceContextStartOffset:
                  sentenceContextStartOffset + (lineStartOffsets[lineIndex] ?? 0),
                sentenceContextText,
              })
            : getSentenceTextsForLine(line);

        return (
          <div key={`${text.slice(0, 8)}:${lineIndex}`} className="leading-7">
            {line.length === 0 ? <span>&nbsp;</span> : null}
            {line.map((token, tokenIndex) => (
              <JapaneseToken
                key={`${token.surface}:${tokenIndex}`}
                selectionKey={`${selectionPrefix}:${lineIndex}:${tokenIndex}`}
                srsHighlight={linePromptHighlightKinds[lineIndex]?.[tokenIndex] ?? null}
                token={token}
                sentenceText={sentenceTexts[tokenIndex] ?? text}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

const MemoizedJapaneseRichText = memo(
  JapaneseRichText,
  (previousProps, nextProps) =>
    previousProps.text === nextProps.text &&
    previousProps.inline === nextProps.inline &&
    previousProps.srsHighlightLookup === nextProps.srsHighlightLookup &&
    previousProps.sentenceContextText === nextProps.sentenceContextText &&
    previousProps.sentenceContextStartOffset === nextProps.sentenceContextStartOffset,
);

function JapaneseToken({
  selectionKey,
  srsHighlight,
  token,
  sentenceText,
}: {
  selectionKey: string;
  srsHighlight: PromptSrsHighlightItem | null;
  token: ReaderToken;
  sentenceText: string;
}) {
  const tokenInspectorActions = useTokenInspectorActions();
  const isSelected = useIsTokenSelected(selectionKey);
  const shouldHideFurigana = Boolean(srsHighlight);
  const srsHighlightClassName =
    srsHighlight?.category === 'kanji'
      ? 'relative z-20 bg-fuchsia-400/25 shadow-[inset_0_0_0_1px_rgba(217,70,239,0.35)] hover:bg-fuchsia-400/30'
      : srsHighlight?.category === 'vocab'
        ? 'relative z-10 bg-amber-300/35 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.35)] hover:bg-amber-300/45'
        : null;
  const tokenBody =
    token.hasKanji && token.readingHiragana && !shouldHideFurigana ? (
      <ruby className="align-baseline [ruby-position:over]">
        <span>{token.surface}</span>
        <rt className="text-[0.62em] leading-none text-muted-foreground/90">
          {token.readingHiragana}
        </rt>
      </ruby>
    ) : (
      <span>{token.surface}</span>
    );

  if (!token.isInteractive) {
    return (
      <span className={cn(srsHighlightClassName && 'rounded-sm', srsHighlightClassName)}>
        {tokenBody}
      </span>
    );
  }

  if (srsHighlight) {
    return (
      <button
        type="button"
        className={cn(
          'inline rounded-sm text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          srsHighlightClassName,
          isSelected && 'ring-1 ring-primary/40',
        )}
        onClick={() => {
          tokenInspectorActions?.openSelection(
            {
              kind: 'srs-review',
              srsItem: srsHighlight.srsItem,
            },
            selectionKey,
          );
        }}
      >
        {tokenBody}
      </button>
    );
  }

  const kanjiDetails = getKanjiDetailsForText(token.surface);

  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline rounded-sm text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            srsHighlightClassName,
            isSelected && 'ring-1 ring-primary/40',
            !srsHighlightClassName &&
              (isSelected
                ? 'bg-primary/15 hover:bg-primary/20'
                : 'hover:bg-muted/60'),
          )}
          onClick={() => {
            tokenInspectorActions?.openSelection(
              {
                kind: 'token',
                sentenceText,
                token,
              },
              selectionKey,
            );
          }}
        >
          {tokenBody}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        sideOffset={10}
        collisionPadding={12}
        sticky="always"
        className="w-72 max-h-[min(calc(100vh-1rem),var(--radix-hover-card-content-available-height))] space-y-2 pr-1"
      >
        <div>
          <p className="text-sm font-semibold leading-tight">{token.surface}</p>
          {token.readingHiragana ? (
            <p className="text-xs text-muted-foreground">{token.readingHiragana}</p>
          ) : null}
        </div>

        <DictionaryReferenceSection token={token} definitionLimit={3} />

        {kanjiDetails.length > 0 ? (
          <div className="border-t border-border/60 pt-2">
            <KanjiReferenceSection kanjiDetails={kanjiDetails} />
          </div>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}

function DictionaryReferenceSection({
  token,
  definitionLimit,
}: {
  token: ReaderToken;
  definitionLimit?: number;
}) {
  const definitions = definitionLimit
    ? token.definitions.slice(0, definitionLimit)
    : token.definitions;

  if (definitions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No dictionary entry found for this token yet.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {definitions.map((definition) => (
        <div
          key={`${definition.entSeq}:${definition.matchedForm}`}
          className="rounded-md border border-border/50 p-2"
        >
          <p className="text-xs font-medium">
            {definition.headword}
            {definition.reading ? `（${definition.reading}）` : ''}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {definition.meanings.slice(0, 3).join(' • ')}
          </p>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {definition.partsOfSpeech.length > 0 ? (
              <p>POS: {definition.partsOfSpeech.join(' • ')}</p>
            ) : null}
            {definition.notes.length > 0 ? <p>Notes: {definition.notes.join(' • ')}</p> : null}
          </div>
          <div className="mt-2">
            <AddToSrsButton input={buildDefinitionSrsInput(token, definition)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function KanjiReferenceSection({
  kanjiDetails,
}: {
  kanjiDetails: KanjiReference[];
}) {
  return (
    <div className="space-y-2">
      {kanjiDetails.map((kanji) => (
        <div key={kanji.literal} className="rounded-md border border-border/50 p-2">
          <p className="text-xs font-semibold">{kanji.literal}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {kanji.meanings.length > 0 ? kanji.meanings.join(' • ') : '—'}
          </p>
          <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span>Onyomi</span>
            <span className="text-foreground">{formatKanjiReadings(kanji.onyomi)}</span>
            <span>Kunyomi</span>
            <span className="text-foreground">{formatKanjiReadings(kanji.kunyomi)}</span>
            <span>JLPT</span>
            <span className="text-foreground">{formatJlptLevel(kanji.jlpt)}</span>
            <span>Frequency</span>
            <span className="text-foreground">{formatFrequency(kanji.freq)}</span>
          </div>
          <div className="mt-2">
            <AddToSrsButton input={buildKanjiSrsInput(kanji)} />
          </div>
        </div>
      ))}
    </div>
  );
}

function AddToSrsButton({ input }: { input: CreateSrsItemInput }) {
  const srsActions = useSrsActions();
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  if (!srsActions) {
    return null;
  }

  const handleClick = async () => {
    setIsSaving(true);
    setStatusMessage(null);
    setIsError(false);

    try {
      await srsActions.createItem(input);
      setStatusMessage('Saved to SRS.');
    } catch (error) {
      setIsError(true);
      setStatusMessage(
        toErrorMessage(error, 'Unable to save this SRS item.'),
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 px-2 text-[11px]"
        onClick={() => {
          void handleClick();
        }}
        disabled={isSaving}
      >
        {isSaving ? (
          <>
            <LoaderCircle className="mr-1 size-3 animate-spin" />
            Saving…
          </>
        ) : (
          'Add to SRS'
        )}
      </Button>
      {statusMessage ? (
        <p className={cn('text-[11px]', isError ? 'text-destructive' : 'text-muted-foreground')}>
          {statusMessage}
        </p>
      ) : null}
    </div>
  );
}

function SettingsPage({
  isBusy,
  errorMessage,
  preferences,
  onBack,
  onClearSrsData,
  onJlptLevelChange,
  onThemeChange,
  onActiveProviderKindChange,
  onSaveProviderPreferences,
}: {
  isBusy: boolean;
  errorMessage: string | null;
  preferences: UserPreferencesSnapshot | null;
  onBack: () => void;
  onClearSrsData: () => Promise<SrsClearResult>;
  onJlptLevelChange: (level: JlptLevel) => void;
  onThemeChange: (theme: ThemeMode) => void;
  onActiveProviderKindChange: (kind: InferenceProviderKind) => void;
  onSaveProviderPreferences: (update: UserPreferencesUpdate) => Promise<void>;
}) {
  const [openAiDraft, setOpenAiDraft] = useState({
    model: '',
    apiKey: '',
    baseUrl: '',
    organizationId: '',
    projectId: '',
  });
  const [lmStudioDraft, setLmStudioDraft] = useState({
    model: '',
    apiKey: '',
    baseUrl: '',
  });
  const [isConfirmingSrsDelete, setIsConfirmingSrsDelete] = useState(false);
  const [isDeletingSrsData, setIsDeletingSrsData] = useState(false);
  const [srsDeleteMessage, setSrsDeleteMessage] = useState<string | null>(null);
  const [srsDeleteError, setSrsDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!preferences) {
      return;
    }

    setOpenAiDraft({
      model: preferences.providers.openai.model,
      apiKey: '',
      baseUrl: preferences.providers.openai.baseUrl,
      organizationId: preferences.providers.openai.organizationId ?? '',
      projectId: preferences.providers.openai.projectId ?? '',
    });

    setLmStudioDraft({
      model: preferences.providers.lmStudio.model,
      apiKey: '',
      baseUrl: preferences.providers.lmStudio.baseUrl,
    });
  }, [preferences]);

  const activeProviderKind = preferences?.activeProviderKind ?? 'openai';

  const persistOpenAiSettings = useCallback(async () => {
    if (!preferences) {
      return;
    }

    const apiKey = openAiDraft.apiKey.trim();
    const organizationId = openAiDraft.organizationId.trim();
    const projectId = openAiDraft.projectId.trim();
    const hasNonKeyChanges =
      openAiDraft.model !== preferences.providers.openai.model ||
      openAiDraft.baseUrl !== preferences.providers.openai.baseUrl ||
      (organizationId.length > 0 ? organizationId : null) !==
        preferences.providers.openai.organizationId ||
      (projectId.length > 0 ? projectId : null) !==
        preferences.providers.openai.projectId;

    if (!hasNonKeyChanges && apiKey.length === 0) {
      return;
    }

    await onSaveProviderPreferences({
      providers: {
        openai: {
          model: openAiDraft.model,
          baseUrl: openAiDraft.baseUrl,
          organizationId,
          projectId,
          ...(apiKey ? { apiKey } : {}),
        },
      },
    });

    if (apiKey.length > 0) {
      setOpenAiDraft((current) => ({
        ...current,
        apiKey: '',
      }));
    }
  }, [onSaveProviderPreferences, openAiDraft, preferences]);

  const persistLmStudioSettings = useCallback(async () => {
    if (!preferences) {
      return;
    }

    const apiKey = lmStudioDraft.apiKey.trim();
    const hasNonKeyChanges =
      lmStudioDraft.model !== preferences.providers.lmStudio.model ||
      lmStudioDraft.baseUrl !== preferences.providers.lmStudio.baseUrl;

    if (!hasNonKeyChanges && apiKey.length === 0) {
      return;
    }

    await onSaveProviderPreferences({
      providers: {
        lmStudio: {
          model: lmStudioDraft.model,
          baseUrl: lmStudioDraft.baseUrl,
          ...(apiKey ? { apiKey } : {}),
        },
      },
    });

    if (apiKey.length > 0) {
      setLmStudioDraft((current) => ({
        ...current,
        apiKey: '',
      }));
    }
  }, [lmStudioDraft, onSaveProviderPreferences, preferences]);

  const handleConfirmClearSrsData = useCallback(async () => {
    setIsDeletingSrsData(true);
    setSrsDeleteError(null);
    setSrsDeleteMessage(null);

    try {
      const result = await onClearSrsData();
      setSrsDeleteMessage(
        result.deletedLegacyCount > 0
          ? `Deleted ${result.deletedCount} SRS item${result.deletedCount === 1 ? '' : 's'} and ${result.deletedLegacyCount} legacy item${result.deletedLegacyCount === 1 ? '' : 's'}.`
          : `Deleted ${result.deletedCount} SRS item${result.deletedCount === 1 ? '' : 's'}.`,
      );
      setIsConfirmingSrsDelete(false);
    } catch (error) {
      setSrsDeleteError(
        toErrorMessage(error, 'Unable to delete SRS data.'),
      );
    } finally {
      setIsDeletingSrsData(false);
    }
  }, [onClearSrsData]);

  return (
    <main className="min-h-screen bg-background p-4 sm:p-6">
      <div className="flex min-h-[calc(100vh-2rem)] items-center justify-center sm:min-h-[calc(100vh-3rem)]">
        <Card className="w-full max-w-xl border-border/60">
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Settings</CardTitle>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Back"
                onClick={onBack}
              >
                <ArrowLeft className="size-5" />
              </Button>
            </div>
          </CardHeader>

          {errorMessage ? (
            <div className="mx-4 mb-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </div>
          ) : null}

          {!preferences ? (
            <CardContent>
              <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                Loading preferences…
              </div>
            </CardContent>
          ) : (
            <CardContent className="space-y-6">
              <div>
                <p className="text-sm font-medium">Theme</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button
                    variant={preferences.theme === 'light' ? 'default' : 'outline'}
                    onClick={() => onThemeChange('light')}
                    disabled={isBusy}
                  >
                    Light
                  </Button>
                  <Button
                    variant={preferences.theme === 'dark' ? 'default' : 'outline'}
                    onClick={() => onThemeChange('dark')}
                    disabled={isBusy}
                  >
                    Dark
                  </Button>
                </div>
              </div>

              <Separator />

              <div>
                <label className="text-sm font-medium" htmlFor="jlpt-level">
                  JLPT response level
                </label>
                <select
                  id="jlpt-level"
                  className={INPUT_CLASSNAME}
                  value={preferences.jlptLevel}
                  onChange={(event) =>
                    onJlptLevelChange(event.target.value as JlptLevel)
                  }
                  disabled={isBusy}
                >
                  <option value="N5">N5</option>
                  <option value="N4">N4</option>
                  <option value="N3">N3</option>
                  <option value="N2">N2</option>
                  <option value="N1">N1</option>
                </select>
              </div>

              <Separator />

              <div>
                <label className="text-sm font-medium" htmlFor="active-provider-kind">
                  Inference provider
                </label>
                <select
                  id="active-provider-kind"
                  className={INPUT_CLASSNAME}
                  value={activeProviderKind}
                  onChange={(event) =>
                    onActiveProviderKindChange(event.target.value as InferenceProviderKind)
                  }
                  disabled={isBusy}
                >
                  <option value="openai">OpenAI</option>
                  <option value="lm-studio">LM Studio</option>
                </select>
              </div>

              <Separator />

              {activeProviderKind === 'openai' ? (
                <div className="space-y-3">
                  <label className="block">
                    <span className="text-sm font-medium">Model</span>
                    <input
                      className={INPUT_CLASSNAME}
                      value={openAiDraft.model}
                      onChange={(event) =>
                        setOpenAiDraft((current) => ({
                          ...current,
                          model: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        void persistOpenAiSettings();
                      }}
                      disabled={isBusy}
                    />
                  </label>

                  <label className="block">
                    <span className="text-sm font-medium">API key</span>
                    <input
                      type="password"
                      className={INPUT_CLASSNAME}
                      value={openAiDraft.apiKey}
                      placeholder={
                        preferences.providers.openai.hasApiKey
                          ? 'Saved (enter to replace)'
                          : 'Enter API key'
                      }
                      onChange={(event) =>
                        setOpenAiDraft((current) => ({
                          ...current,
                          apiKey: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        if (openAiDraft.apiKey.trim()) {
                          void persistOpenAiSettings();
                        }
                      }}
                      disabled={isBusy}
                    />
                  </label>

                  <label className="block">
                    <span className="text-sm font-medium">Base URL</span>
                    <input
                      className={INPUT_CLASSNAME}
                      value={openAiDraft.baseUrl}
                      onChange={(event) =>
                        setOpenAiDraft((current) => ({
                          ...current,
                          baseUrl: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        void persistOpenAiSettings();
                      }}
                      disabled={isBusy}
                    />
                  </label>

                  <label className="block">
                    <span className="text-sm font-medium">Organization ID</span>
                    <input
                      className={INPUT_CLASSNAME}
                      value={openAiDraft.organizationId}
                      onChange={(event) =>
                        setOpenAiDraft((current) => ({
                          ...current,
                          organizationId: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        void persistOpenAiSettings();
                      }}
                      disabled={isBusy}
                    />
                  </label>

                  <label className="block">
                    <span className="text-sm font-medium">Project ID</span>
                    <input
                      className={INPUT_CLASSNAME}
                      value={openAiDraft.projectId}
                      onChange={(event) =>
                        setOpenAiDraft((current) => ({
                          ...current,
                          projectId: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        void persistOpenAiSettings();
                      }}
                      disabled={isBusy}
                    />
                  </label>
                </div>
              ) : (
                <div className="space-y-3">
                  <label className="block">
                    <span className="text-sm font-medium">Local URL</span>
                    <input
                      className={INPUT_CLASSNAME}
                      value={lmStudioDraft.baseUrl}
                      onChange={(event) =>
                        setLmStudioDraft((current) => ({
                          ...current,
                          baseUrl: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        void persistLmStudioSettings();
                      }}
                      disabled={isBusy}
                    />
                  </label>

                  <label className="block">
                    <span className="text-sm font-medium">Model</span>
                    <input
                      className={INPUT_CLASSNAME}
                      value={lmStudioDraft.model}
                      onChange={(event) =>
                        setLmStudioDraft((current) => ({
                          ...current,
                          model: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        void persistLmStudioSettings();
                      }}
                      disabled={isBusy}
                    />
                  </label>

                  <label className="block">
                    <span className="text-sm font-medium">API key (optional)</span>
                    <input
                      type="password"
                      className={INPUT_CLASSNAME}
                      value={lmStudioDraft.apiKey}
                      placeholder={
                        preferences.providers.lmStudio.hasApiKey
                          ? 'Saved (enter to replace)'
                          : 'Optional'
                      }
                      onChange={(event) =>
                        setLmStudioDraft((current) => ({
                          ...current,
                          apiKey: event.target.value,
                        }))
                      }
                      onBlur={() => {
                        if (lmStudioDraft.apiKey.trim()) {
                          void persistLmStudioSettings();
                        }
                      }}
                      disabled={isBusy}
                    />
                  </label>
                </div>
              )}

              <Separator />

              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium text-destructive">Delete SRS data</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Remove all saved SRS cards from this app instance.
                    </p>
                  </div>

                  {srsDeleteError ? (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {srsDeleteError}
                    </div>
                  ) : null}

                  {srsDeleteMessage ? (
                    <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
                      {srsDeleteMessage}
                    </div>
                  ) : null}

                  {isConfirmingSrsDelete ? (
                    <div className="space-y-3 rounded-lg border border-destructive/30 bg-background/70 p-3">
                      <p className="text-sm text-foreground">
                        Are you sure? This will permanently delete all SRS data for this app.
                      </p>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            setIsConfirmingSrsDelete(false);
                          }}
                          disabled={isDeletingSrsData}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={() => {
                            void handleConfirmClearSrsData();
                          }}
                          disabled={isBusy || isDeletingSrsData}
                        >
                          {isDeletingSrsData ? (
                            <>
                              <LoaderCircle className="mr-2 size-4 animate-spin" />
                              Deleting…
                            </>
                          ) : (
                            'Yes, delete SRS data'
                          )}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={() => {
                          setSrsDeleteError(null);
                          setSrsDeleteMessage(null);
                          setIsConfirmingSrsDelete(true);
                        }}
                        disabled={isBusy || isDeletingSrsData}
                      >
                        <Trash2 className="mr-2 size-4" />
                        Delete SRS data
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          )}

          <CardFooter className="justify-end">
            <Button variant="outline" onClick={onBack}>
              Done
            </Button>
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}

function SrsReviewCard({
  stats,
  isLoading,
  errorMessage,
  onStartReview,
}: {
  stats: SrsStats;
  isLoading: boolean;
  errorMessage: string | null;
  onStartReview: () => void;
}) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleExport = async () => {
    setIsExporting(true);
    setExportMessage(null);
    setExportError(null);

    try {
      const result = await window.languageApp.srs.exportItems();
      setExportMessage(`Exported ${result.itemCount} item${result.itemCount === 1 ? '' : 's'} to ${result.filePath}`);
    } catch (error) {
      setExportError(
        toErrorMessage(error, 'Unable to export SRS data.'),
      );
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Card className="border-border/60">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>Review SRS</CardTitle>
            <CardDescription>Review queue and tracked chat items.</CardDescription>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" onClick={onStartReview}>
              Review
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void handleExport();
              }}
              disabled={isExporting}
            >
              {isExporting ? (
                <>
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                  Exporting…
                </>
              ) : (
                'Export SRS'
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {errorMessage ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {errorMessage}
          </div>
        ) : null}

        {exportError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {exportError}
          </div>
        ) : null}

        {exportMessage ? (
          <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            {exportMessage}
          </div>
        ) : null}

        <div className={cn('grid grid-cols-3 gap-3', isLoading && 'opacity-60')}>
          <ReviewStat label="Due now" value={stats.dueNow} />
          <ReviewStat label="New" value={stats.newCards} />
          <ReviewStat label="Tracked" value={stats.totalTracked} />
        </div>

        <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
          <p className="font-medium tracking-tight">SRS overview</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Review due cards here, and keep adding vocab, kanji, and sentence cards
            from the chat experience.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ReviewStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/70 p-3">
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-xl font-semibold tracking-tight">{value}</p>
    </div>
  );
}
