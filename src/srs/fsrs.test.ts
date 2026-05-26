import { describe, expect, it } from 'vitest';
import {
  FSRS_NEW_STATE,
  applyFsrsReview,
  createInitialFsrsCard,
  fsrsStateLabel,
  previewFsrsReviews,
  serializeFsrsCard,
  toFsrsCardInput,
  toFsrsReviewGrade,
} from './fsrs';

describe('FSRS helpers', () => {
  it('serializes and restores persisted card fields', () => {
    const createdAt = new Date('2025-05-25T10:00:00.000Z');
    const card = createInitialFsrsCard(createdAt);
    const persisted = serializeFsrsCard(card);

    expect(persisted.lastReview).toBeNull();
    expect(toFsrsCardInput(persisted)).toEqual({
      due: createdAt.toISOString(),
      stability: card.stability,
      difficulty: card.difficulty,
      elapsed_days: card.elapsed_days,
      scheduled_days: card.scheduled_days,
      learning_steps: card.learning_steps,
      reps: card.reps,
      lapses: card.lapses,
      state: card.state,
      last_review: null,
    });
  });

  it('maps ratings and produces review previews', () => {
    const fields = {
      due: '2025-05-25T10:00:00.000Z',
      stability: 3,
      difficulty: 4,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reps: 0,
      lapses: 0,
      state: FSRS_NEW_STATE,
      lastReview: null,
    };

    expect(toFsrsReviewGrade('again')).not.toBeUndefined();
    expect(fsrsStateLabel(FSRS_NEW_STATE)).toBe('New');

    const previews = previewFsrsReviews(fields, new Date('2025-05-25T10:00:00.000Z'));

    expect(previews).toHaveLength(4);
    expect(previews.map((preview) => preview.rating)).toEqual(['again', 'hard', 'good', 'easy']);
    expect(previews.every((preview) => typeof preview.due === 'string')).toBe(true);
  });

  it('applies a review and returns a log item', () => {
    const fields = {
      due: '2025-05-25T10:00:00.000Z',
      stability: 3,
      difficulty: 4,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reps: 0,
      lapses: 0,
      state: FSRS_NEW_STATE,
      lastReview: null,
    };

    const result = applyFsrsReview(fields, 'good', new Date('2025-05-25T10:00:00.000Z'));

    expect(result).toHaveProperty('card');
    expect(result).toHaveProperty('log');
    expect(result.log.rating).toBe(3);
    expect(result.log.review).toBeInstanceOf(Date);
  });
});