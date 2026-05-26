import { describe, expect, it } from 'vitest';
import {
  buildSearchTargets,
  buildSrsExportMarkdown,
  hasKanji,
  indentMultiline,
  compareDictionaryWordMatches,
  exactnessForTarget,
  isSrsReviewRating,
  normalizeSourceEntryId,
  normalizeSrsCategory,
  normalizeSrsCategoryFilters,
  parseChatMessages,
  sanitizeChatMessageCorrection,
  uniqueStrings,
} from './database';

describe('database helper logic', () => {
  it('normalizes categories and source IDs', () => {
    expect(normalizeSrsCategory('vocab')).toBe('vocab');
    expect(normalizeSrsCategory('not-a-category')).toBe('translate');
    expect(normalizeSrsCategoryFilters(['kanji', 'kanji', 'vocab', 'invalid' as never])).toEqual([
      'kanji',
      'vocab',
    ]);
    expect(normalizeSourceEntryId(12)).toBe(12);
    expect(normalizeSourceEntryId(0)).toBeNull();
    expect(normalizeSourceEntryId(2.5)).toBeNull();
  });

  it('validates review ratings and string helpers', () => {
    expect(isSrsReviewRating('good')).toBe(true);
    expect(isSrsReviewRating('nope')).toBe(false);
    expect(uniqueStrings([' a ', 'a', null, undefined, 'b'])).toEqual(['a', 'b']);
    expect(hasKanji('日本語')).toBe(true);
    expect(hasKanji('nihongo')).toBe(false);
    expect(indentMultiline('line1\nline2')).toBe('    line1\n    line2');
  });

  it('builds dictionary search targets and ranks word matches', () => {
    expect(
      buildSearchTargets({
        surfaceForm: 'たべる',
        basicForm: 'たべます',
        reading: 'たべた',
        partOfSpeech: 'verb',
      }),
    ).toEqual([
      { value: 'たべる', kind: 'text', priority: 0 },
      { value: 'たべる', kind: 'reading', priority: 0 },
      { value: 'たべます', kind: 'text', priority: 1 },
      { value: 'たべます', kind: 'reading', priority: 1 },
      { value: 'たべた', kind: 'reading', priority: 2 },
    ]);

    expect(
      exactnessForTarget(
        {
          kanji: [{ text: '食べる', common: true }],
          kana: [{ text: 'たべる', common: false }],
        } as never,
        { value: '食べる', kind: 'text', priority: 0 },
      ),
    ).toBe(0);

    expect(
      exactnessForTarget(
        {
          kanji: [{ text: '食べる', common: false }],
          kana: [{ text: 'たべる', common: true }],
        } as never,
        { value: 'たべる', kind: 'reading', priority: 0 },
      ),
    ).toBe(0);

    expect(
      compareDictionaryWordMatches(
        {
          target: { value: 'a', kind: 'text', priority: 0 },
          exactness: 0,
          partOfSpeechPenalty: 0,
          matchedFormPenalty: 0,
          commonnessPenalty: 0,
          lengthPenalty: 0,
          word: { id: '1' },
        } as never,
        {
          target: { value: 'b', kind: 'text', priority: 1 },
          exactness: 0,
          partOfSpeechPenalty: 0,
          matchedFormPenalty: 0,
          commonnessPenalty: 0,
          lengthPenalty: 0,
          word: { id: '2' },
        } as never,
      ),
    ).toBeLessThan(0);
  });

  it('sanitizes corrections and parses chat history', () => {
    expect(
      sanitizeChatMessageCorrection({
        correctedText: '昨日は行った。',
        translation: 'I went yesterday.',
        generatedAt: '2025-05-25T10:00:00.000Z',
        corrections: [
          {
            originalText: '昨日行った',
            correctedText: '昨日は行った。',
            explanation: 'Added は.',
          },
          {
            originalText: 123,
            correctedText: 'ignored',
            explanation: 'ignored',
          },
        ],
      }),
    ).toEqual({
      correctedText: '昨日は行った。',
      translation: 'I went yesterday.',
      generatedAt: '2025-05-25T10:00:00.000Z',
      corrections: [
        {
          originalText: '昨日行った',
          correctedText: '昨日は行った。',
          explanation: 'Added は.',
        },
      ],
    });

    expect(
      parseChatMessages(
        JSON.stringify([
          {
            role: 'user',
            content: 'こんにちは',
            createdAt: '2025-05-25T10:00:00.000Z',
            correction: {
              correctedText: 'こんにちは',
              translation: 'Hello',
              generatedAt: '2025-05-25T10:00:00.000Z',
              corrections: [],
            },
          },
          { role: 'assistant', content: '返事', createdAt: '2025-05-25T10:01:00.000Z' },
        ]),
      ),
    ).toHaveLength(2);
  });

  it('renders export markdown with a readable answer block', () => {
    const markdown = buildSrsExportMarkdown(
      [
        {
          id: '1',
          item: '日本語',
          answer: 'line1\nline2',
          category: 'vocab',
          source_entry_id: 42,
          created_time: '2025-05-25T10:00:00.000Z',
          last_updated_time: '2025-05-25T11:00:00.000Z',
          due: '2025-05-26T10:00:00.000Z',
          stability: 3,
          difficulty: 4,
          elapsed_days: 1,
          scheduled_days: 2,
          learning_steps: 0,
          reps: 2,
          lapses: 0,
          state: 2,
          last_review: null,
        },
      ] as never,
      '2025-05-25T12:00:00.000Z',
    );

    expect(markdown).toContain('# ToraChat SRS Export');
    expect(markdown).toContain('- Total cards: 1');
    expect(markdown).toContain('    line1');
    expect(markdown).toContain('    line2');
  });
});