import {
  State,
  Rating,
  createEmptyCard,
  fsrs,
  generatorParameters,
  type Card,
  type CardInput,
  type Grade,
  type RecordLogItem,
} from 'ts-fsrs';
import {
  SRS_REVIEW_RATINGS,
  type SrsReviewRating,
} from '../shared/srs-review';

export interface PersistedFsrsCardFields {
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

export interface FsrsReviewPreview {
  rating: SrsReviewRating;
  due: string;
  scheduledDays: number;
  learningSteps: number;
}

const FSRS_REVIEW_RATING_TO_GRADE: Record<SrsReviewRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

export const fsrsScheduler = fsrs(
  generatorParameters({
    enable_fuzz: true,
    enable_short_term: true,
  }),
);

export const createInitialFsrsCard = (createdAt: Date = new Date()): Card =>
  createEmptyCard(createdAt);

export const serializeFsrsCard = (card: Card): PersistedFsrsCardFields => ({
  due: card.due.toISOString(),
  stability: card.stability,
  difficulty: card.difficulty,
  elapsedDays: card.elapsed_days,
  scheduledDays: card.scheduled_days,
  learningSteps: card.learning_steps,
  reps: card.reps,
  lapses: card.lapses,
  state: card.state,
  lastReview: card.last_review ? card.last_review.toISOString() : null,
});

export const toFsrsCardInput = (
  fields: PersistedFsrsCardFields,
): CardInput => ({
  due: fields.due,
  stability: fields.stability,
  difficulty: fields.difficulty,
  elapsed_days: fields.elapsedDays,
  scheduled_days: fields.scheduledDays,
  learning_steps: fields.learningSteps,
  reps: fields.reps,
  lapses: fields.lapses,
  state: fields.state as State,
  last_review: fields.lastReview,
});

export const toFsrsReviewGrade = (rating: SrsReviewRating): Grade =>
  FSRS_REVIEW_RATING_TO_GRADE[rating];

export const previewFsrsReviews = (
  fields: PersistedFsrsCardFields,
  reviewedAt: Date = new Date(),
): FsrsReviewPreview[] =>
  SRS_REVIEW_RATINGS.map((rating) => {
    const result = fsrsScheduler.next(
      toFsrsCardInput(fields),
      reviewedAt,
      toFsrsReviewGrade(rating),
    );

    return {
      rating,
      due: result.card.due.toISOString(),
      scheduledDays: result.card.scheduled_days,
      learningSteps: result.card.learning_steps,
    };
  });

export const applyFsrsReview = (
  fields: PersistedFsrsCardFields,
  rating: SrsReviewRating,
  reviewedAt: Date = new Date(),
): RecordLogItem =>
  fsrsScheduler.next(toFsrsCardInput(fields), reviewedAt, toFsrsReviewGrade(rating));

export const fsrsStateLabel = (state: number) =>
  State[state] ?? `Unknown(${state})`;

export const FSRS_NEW_STATE = State.New;
