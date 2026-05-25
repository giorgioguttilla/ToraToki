import Kanji, { type Word as KanjiWord } from 'kanji.js';

export interface KanjiReference {
  literal: string;
  freq: number | null;
  jlpt: number | null;
  meanings: string[];
  onyomi: string[];
  kunyomi: string[];
}

const KANJI_PATTERN = /[\u3400-\u9FFF々〆ヵヶ]/gu;
const kanjiDetailsCache = new Map<string, KanjiReference | null>();

const toKanjiReference = (word: KanjiWord | null | undefined): KanjiReference | null => {
  if (!word) {
    return null;
  }

  return {
    literal: word.literal,
    freq: typeof word.freq === 'number' ? word.freq : null,
    jlpt: typeof word.jlpt === 'number' ? word.jlpt : null,
    meanings: Array.isArray(word.meanings) ? word.meanings : [],
    onyomi: Array.isArray(word.onyomi) ? word.onyomi : [],
    kunyomi: Array.isArray(word.kunyomi) ? word.kunyomi : [],
  };
};

const getKanjiReference = (character: string) => {
  if (!kanjiDetailsCache.has(character)) {
    kanjiDetailsCache.set(character, toKanjiReference(Kanji.getDetails(character)));
  }

  return kanjiDetailsCache.get(character) ?? null;
};

export const getKanjiDetailsForText = (text: string) => {
  const characters = [...new Set(text.match(KANJI_PATTERN) ?? [])];

  return characters
    .map((character) => getKanjiReference(character))
    .filter((character): character is KanjiReference => character !== null);
};

export const formatJlptLevel = (level: number | null) =>
  level ? `N${level}` : '—';

export const formatFrequency = (frequency: number | null) =>
  frequency ? `#${frequency}` : '—';

export const formatKanjiReadings = (readings: string[]) =>
  readings.length > 0 ? readings.join('、') : '—';
