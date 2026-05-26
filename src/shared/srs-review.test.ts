import { describe, expect, it } from 'vitest';
import {
  SRS_REVIEW_RATINGS,
  SRS_REVIEW_SHORTCUTS,
  getSrsReviewRatingLabel,
} from './srs-review';

describe('shared SRS review helpers', () => {
  it('keeps the rating order and keyboard shortcuts aligned', () => {
    expect(SRS_REVIEW_RATINGS).toEqual(['again', 'hard', 'good', 'easy']);
    expect(SRS_REVIEW_SHORTCUTS).toEqual({
      again: '1',
      hard: '2',
      good: '3',
      easy: '4',
    });
  });

  it('returns the display label for each rating', () => {
    expect(getSrsReviewRatingLabel('again')).toBe('Again');
    expect(getSrsReviewRatingLabel('hard')).toBe('Hard');
    expect(getSrsReviewRatingLabel('good')).toBe('Good');
    expect(getSrsReviewRatingLabel('easy')).toBe('Easy');
  });
});