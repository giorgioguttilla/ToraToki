export const SRS_REVIEW_RATINGS = ['again', 'hard', 'good', 'easy'] as const;

export type SrsReviewRating = (typeof SRS_REVIEW_RATINGS)[number];

export const SRS_REVIEW_SHORTCUTS: Record<SrsReviewRating, '1' | '2' | '3' | '4'> = {
  again: '1',
  hard: '2',
  good: '3',
  easy: '4',
};

export const getSrsReviewRatingLabel = (rating: SrsReviewRating) => {
  switch (rating) {
    case 'again':
      return 'Again';
    case 'hard':
      return 'Hard';
    case 'good':
      return 'Good';
    case 'easy':
      return 'Easy';
    default:
      return rating;
  }
};
