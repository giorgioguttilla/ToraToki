import type { DictionaryEntry, SrsItem } from '@/shared/language-api';

const KANA_ALONE_NOTE_FRAGMENT = 'word usually written using kana alone';

type SrsItemTextLike = Pick<SrsItem, 'item' | 'answer' | 'category'>;

const normalizeText = (value: string | null | undefined) => value?.trim() ?? '';

const parseAnswerField = (answer: string, label: string) => {
  const prefix = `${label}:`;

  for (const line of answer.split('\n')) {
    if (!line.startsWith(prefix)) {
      continue;
    }

    const value = line.slice(prefix.length).trim();

    return value.length > 0 ? value : null;
  }

  return null;
};

const parseAnswerNotes = (answer: string) => {
  const value = parseAnswerField(answer, 'Notes');

  if (!value) {
    return [] as string[];
  }

  return value
    .split(' • ')
    .map((note) => note.trim())
    .filter((note) => note.length > 0);
};

const includesKanaAloneNote = (notes: string[]) =>
  notes.some((note) => note.toLocaleLowerCase().includes(KANA_ALONE_NOTE_FRAGMENT));

const uniqueNormalizedTexts = (values: Array<string | null | undefined>) => {
  const dedupedValues = new Set<string>();

  for (const value of values) {
    const normalizedValue = normalizeText(value);

    if (!normalizedValue) {
      continue;
    }

    dedupedValues.add(normalizedValue);
  }

  return [...dedupedValues];
};

export const shouldPreferKanaOnlyDictionaryEntry = (definition: DictionaryEntry) =>
  Boolean(normalizeText(definition.reading)) && includesKanaAloneNote(definition.notes);

export const getPreferredDictionarySrsItemText = ({
  definition,
  fallbackText,
}: {
  definition: DictionaryEntry;
  fallbackText: string;
}) => {
  const preferredReading = normalizeText(definition.reading);

  if (preferredReading && shouldPreferKanaOnlyDictionaryEntry(definition)) {
    return preferredReading;
  }

  return (
    normalizeText(definition.headword) ||
    normalizeText(definition.matchedForm) ||
    normalizeText(fallbackText)
  );
};

export const shouldPreferKanaOnlySrsItemText = (item: SrsItemTextLike) => {
  if (item.category !== 'vocab') {
    return false;
  }

  const reading = parseAnswerField(item.answer, 'Reading');

  return Boolean(reading) && includesKanaAloneNote(parseAnswerNotes(item.answer));
};

export const getPreferredSrsItemText = (item: SrsItemTextLike) => {
  const preferredReading = parseAnswerField(item.answer, 'Reading');

  if (preferredReading && shouldPreferKanaOnlySrsItemText(item)) {
    return preferredReading;
  }

  return normalizeText(item.item);
};

export const getSrsItemMatchTexts = (item: SrsItemTextLike) => {
  const preferredReading = parseAnswerField(item.answer, 'Reading');
  const preferredItemText = getPreferredSrsItemText(item);

  return uniqueNormalizedTexts([
    preferredItemText,
    item.item,
    shouldPreferKanaOnlySrsItemText(item) ? preferredReading : null,
  ]);
};
