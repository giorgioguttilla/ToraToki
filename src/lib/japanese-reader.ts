import * as kuromoji from '@patdx/kuromoji';
import type { IpadicFeatures, LoaderConfig, Tokenizer } from '@patdx/kuromoji';
import Kuroshiro from 'kuroshiro';
import type {
  DictionaryEntry,
  DictionaryLookupQuery,
} from '@/shared/language-api';

export interface ReaderToken {
  surface: string;
  basicForm: string;
  readingKatakana: string | null;
  readingHiragana: string | null;
  pronunciation: string | null;
  partOfSpeech: string;
  partOfSpeechDetail: string;
  startOffset: number;
  endOffset: number;
  hasKanji: boolean;
  isInteractive: boolean;
  definitions: DictionaryEntry[];
}

export interface ReaderAnalysis {
  text: string;
  lines: ReaderToken[][];
  contentTokenCount: number;
  matchedTokenCount: number;
}

interface PhraseLookupCandidate {
  lookupKey: string;
  query: DictionaryLookupQuery;
  tokenKeys: string[];
}

const dictionaryFileCache = new Map<string, Promise<ArrayBuffer>>();
let tokenizerPromise: Promise<Tokenizer> | null = null;
const PHRASE_TOKEN_LIMIT = 4;
const PHRASE_FRIENDLY_PARTS_OF_SPEECH = new Set([
  '名詞',
  '動詞',
  '形容詞',
  '副詞',
  '連体詞',
  '感動詞',
]);

const normalizeFileName = (requestedPath: string) => {
  const segments = requestedPath.split('/').filter(Boolean);
  const fileName = segments.at(-1);

  if (!fileName) {
    throw new Error(`Unable to resolve Kuromoji dictionary file: ${requestedPath}`);
  }

  return fileName;
};

const browserLoader: LoaderConfig = {
  async loadArrayBuffer(requestedPath: string) {
    const fileName = normalizeFileName(requestedPath);

    if (!dictionaryFileCache.has(fileName)) {
      dictionaryFileCache.set(
        fileName,
        window.languageApp.kuromoji.loadDictionaryFile(fileName),
      );
    }

    return dictionaryFileCache.get(fileName)!;
  },
};

const getTokenizer = () => {
  if (!tokenizerPromise) {
    tokenizerPromise = new kuromoji.TokenizerBuilder({
      loader: browserLoader,
    }).build();
  }

  return tokenizerPromise;
};

const normalizeReading = (reading?: string | null) =>
  reading ? Kuroshiro.Util.kanaToHiragna(reading) : null;

const hasKanji = (value: string) => [...value].some((char) => Kuroshiro.Util.isKanji(char));

const normalizeBasicForm = (token: IpadicFeatures) =>
  token.basic_form && token.basic_form !== '*' ? token.basic_form : token.surface_form;

const createLookupKey = (query: DictionaryLookupQuery) =>
  [
    query.surfaceForm,
    query.basicForm ?? '',
    query.reading ?? '',
    query.partOfSpeech ?? '',
  ].join('::');

const createLookupQuery = (token: IpadicFeatures): DictionaryLookupQuery => ({
  surfaceForm: token.surface_form,
  basicForm: normalizeBasicForm(token),
  reading: normalizeReading(token.reading),
  partOfSpeech: token.pos,
});

const shouldLookupToken = (token: IpadicFeatures) =>
  token.surface_form.trim().length > 0 && token.pos !== '記号';

const getTokenKey = (lineIndex: number, tokenIndex: number) =>
  `${lineIndex}:${tokenIndex}`;

const shouldLookupPhrase = (tokens: IpadicFeatures[]) => {
  if (tokens.length < 2 || tokens.length > PHRASE_TOKEN_LIMIT) {
    return false;
  }

  if (tokens.some((token) => !shouldLookupToken(token))) {
    return false;
  }

  const surface = tokens.map((token) => token.surface_form).join('');

  if (surface.length < 2 || surface.length > 20) {
    return false;
  }

  if (
    !tokens.some(
      (token) =>
        hasKanji(token.surface_form) ||
        PHRASE_FRIENDLY_PARTS_OF_SPEECH.has(token.pos),
    )
  ) {
    return false;
  }

  return !tokens.every(
    (token) => !hasKanji(token.surface_form) && token.surface_form.length <= 1,
  );
};

const createPhraseLookupCandidate = (
  tokens: IpadicFeatures[],
  lineIndex: number,
  startTokenIndex: number,
): PhraseLookupCandidate => {
  const readingPieces = tokens.map((token) => normalizeReading(token.reading));
  const query: DictionaryLookupQuery = {
    surfaceForm: tokens.map((token) => token.surface_form).join(''),
    basicForm: null,
    reading: readingPieces.every((reading): reading is string => Boolean(reading))
      ? readingPieces.join('')
      : null,
    partOfSpeech: null,
  };

  return {
    lookupKey: createLookupKey(query),
    query,
    tokenKeys: tokens.map((_token, offset) => getTokenKey(lineIndex, startTokenIndex + offset)),
  };
};

const createPhraseLookupCandidates = (tokenLines: IpadicFeatures[][]) => {
  const candidatesByKey = new Map<string, PhraseLookupCandidate>();

  for (const [lineIndex, line] of tokenLines.entries()) {
    for (let startIndex = 0; startIndex < line.length; startIndex += 1) {
      for (let length = PHRASE_TOKEN_LIMIT; length >= 2; length -= 1) {
        const phraseTokens = line.slice(startIndex, startIndex + length);

        if (phraseTokens.length !== length) {
          continue;
        }

        if (!shouldLookupPhrase(phraseTokens)) {
          continue;
        }

        const candidate = createPhraseLookupCandidate(
          phraseTokens,
          lineIndex,
          startIndex,
        );
        const existingCandidate = candidatesByKey.get(candidate.lookupKey);

        if (!existingCandidate) {
          candidatesByKey.set(candidate.lookupKey, candidate);
          continue;
        }

        existingCandidate.tokenKeys = Array.from(
          new Set([...existingCandidate.tokenKeys, ...candidate.tokenKeys]),
        );
      }
    }
  }

  return [...candidatesByKey.values()];
};

const mergeDefinitions = (
  directDefinitions: DictionaryEntry[],
  phraseDefinitions: DictionaryEntry[][],
) => {
  const mergedEntries = [...directDefinitions, ...phraseDefinitions.flat()];
  const dedupedEntries = new Map<string, DictionaryEntry>();

  for (const entry of mergedEntries) {
    const entryKey = `${entry.entSeq}:${entry.matchedForm}`;

    if (!dedupedEntries.has(entryKey)) {
      dedupedEntries.set(entryKey, entry);
    }
  }

  return [...dedupedEntries.values()];
};

const buildReaderToken = async (
  token: IpadicFeatures,
  lineIndex: number,
  tokenIndex: number,
  startOffset: number,
  lookupCache: Map<string, Promise<DictionaryEntry[]>>,
  phraseLookupCache: Map<string, Promise<DictionaryEntry[]>>,
  phraseLookupKeysByToken: Map<string, string[]>,
): Promise<ReaderToken> => {
  const directLookupKey = createLookupKey(createLookupQuery(token));
  const tokenKey = getTokenKey(lineIndex, tokenIndex);
  const readingHiragana = normalizeReading(token.reading);
  const directDefinitions = lookupCache.has(directLookupKey)
    ? await lookupCache.get(directLookupKey)!
    : [];
  const phraseDefinitions = await Promise.all(
    (phraseLookupKeysByToken.get(tokenKey) ?? []).map(
      async (lookupKey): Promise<DictionaryEntry[]> => {
        const phraseLookup = phraseLookupCache.get(lookupKey);

        return phraseLookup ? await phraseLookup : [];
      },
    ),
  );
  const definitions = mergeDefinitions(directDefinitions, phraseDefinitions);
  const tokenHasKanji = hasKanji(token.surface_form);

  return {
    surface: token.surface_form,
    basicForm: normalizeBasicForm(token),
    readingKatakana: token.reading ?? null,
    readingHiragana,
    pronunciation: token.pronunciation ?? null,
    partOfSpeech: token.pos,
    partOfSpeechDetail: token.pos_detail_1,
    startOffset,
    endOffset: startOffset + token.surface_form.length,
    hasKanji: tokenHasKanji,
    isInteractive:
      token.pos !== '記号' &&
      (definitions.length > 0 || tokenHasKanji || Boolean(readingHiragana)),
    definitions,
  };
};

export const analyzeJapaneseText = async (text: string): Promise<ReaderAnalysis> => {
  const tokenizer = await getTokenizer();
  const normalizedText = text.replace(/\r\n?/g, '\n').trim();
  const lines = normalizedText.length > 0 ? normalizedText.split('\n') : [''];
  const tokenLines = lines.map((line) => (line.length > 0 ? tokenizer.tokenize(line) : []));
  const lookupCache = new Map<string, Promise<DictionaryEntry[]>>();
  const phraseLookupCache = new Map<string, Promise<DictionaryEntry[]>>();
  const phraseLookupKeysByToken = new Map<string, string[]>();

  for (const line of tokenLines) {
    for (const token of line) {
      if (!shouldLookupToken(token)) {
        continue;
      }

      const lookupQuery = createLookupQuery(token);
      const lookupKey = createLookupKey(lookupQuery);

      if (!lookupCache.has(lookupKey)) {
        lookupCache.set(
          lookupKey,
          window.languageApp.dictionary.lookupEntries(lookupQuery),
        );
      }
    }
  }

  const phraseCandidates = createPhraseLookupCandidates(tokenLines);

  for (const candidate of phraseCandidates) {
    if (!phraseLookupCache.has(candidate.lookupKey)) {
      phraseLookupCache.set(
        candidate.lookupKey,
        window.languageApp.dictionary.lookupEntries(candidate.query),
      );
    }

    for (const tokenKey of candidate.tokenKeys) {
      const existingKeys = phraseLookupKeysByToken.get(tokenKey) ?? [];

      if (!existingKeys.includes(candidate.lookupKey)) {
        phraseLookupKeysByToken.set(tokenKey, [...existingKeys, candidate.lookupKey]);
      }
    }
  }

  const readerLines = await Promise.all(
    tokenLines.map((line, lineIndex) => {
      let currentOffset = 0;

      return Promise.all(
        line.map((token: IpadicFeatures, tokenIndex) => {
          const startOffset = currentOffset;
          currentOffset += token.surface_form.length;

          return buildReaderToken(
            token,
            lineIndex,
            tokenIndex,
            startOffset,
            lookupCache,
            phraseLookupCache,
            phraseLookupKeysByToken,
          );
        }),
      );
    }),
  );

  const flattenedTokens = readerLines.flat();

  return {
    text: normalizedText,
    lines: readerLines,
    contentTokenCount: flattenedTokens.filter(
      (token: ReaderToken) => token.partOfSpeech !== '記号',
    ).length,
    matchedTokenCount: flattenedTokens.filter(
      (token: ReaderToken) => token.definitions.length > 0,
    ).length,
  };
};
