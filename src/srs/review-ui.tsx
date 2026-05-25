import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SrsItem } from '@/shared/language-api';
import {
  SRS_REVIEW_SHORTCUTS,
  getSrsReviewRatingLabel,
  type SrsReviewRating,
} from '@/shared/srs-review';
import { previewFsrsReviews } from './fsrs';

export const KEY_TO_REVIEW_RATING: Record<string, SrsReviewRating> = {
  '1': 'again',
  '2': 'hard',
  '3': 'good',
  '4': 'easy',
};

const REVIEW_RATING_BUTTON_STYLES: Record<SrsReviewRating, string> = {
  again:
    'border-destructive/25 bg-destructive/5 text-destructive hover:bg-destructive/10',
  hard:
    'border-amber-500/25 bg-amber-500/5 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300',
  good:
    'border-primary/25 bg-primary/5 text-primary hover:bg-primary/10',
  easy:
    'border-emerald-500/25 bg-emerald-500/5 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300',
};

const ABSOLUTE_DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
});

export const formatAbsoluteDateTime = (isoString: string) =>
  ABSOLUTE_DATE_TIME_FORMATTER.format(new Date(isoString));

export const formatRelativeDue = (isoString: string) => {
  const deltaMs = new Date(isoString).getTime() - Date.now();
  const absoluteDeltaMs = Math.abs(deltaMs);

  if (absoluteDeltaMs < 60_000) {
    return 'now';
  }

  if (absoluteDeltaMs < 3_600_000) {
    return RELATIVE_TIME_FORMATTER.format(
      Math.round(deltaMs / 60_000),
      'minute',
    );
  }

  if (absoluteDeltaMs < 86_400_000) {
    return RELATIVE_TIME_FORMATTER.format(
      Math.round(deltaMs / 3_600_000),
      'hour',
    );
  }

  return RELATIVE_TIME_FORMATTER.format(
    Math.round(deltaMs / 86_400_000),
    'day',
  );
};

export const getSrsReviewPreviewsForItem = (item: SrsItem, reviewedAt: Date = new Date()) =>
  previewFsrsReviews(
    {
      due: item.due,
      stability: item.stability,
      difficulty: item.difficulty,
      elapsedDays: item.elapsedDays,
      scheduledDays: item.scheduledDays,
      learningSteps: item.learningSteps,
      reps: item.reps,
      lapses: item.lapses,
      state: item.state,
      lastReview: item.lastReview,
    },
    reviewedAt,
  );

export function ReviewRatingButton({
  disabled,
  isSubmitting,
  onClick,
  rating,
  scheduledDue,
}: {
  disabled: boolean;
  isSubmitting: boolean;
  onClick: (rating: SrsReviewRating) => void;
  rating: SrsReviewRating;
  scheduledDue: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className={cn(
        'h-auto min-h-0 items-start justify-between rounded-2xl px-2 py-2 text-left',
        REVIEW_RATING_BUTTON_STYLES[rating],
      )}
      onClick={() => {
        onClick(rating);
      }}
      disabled={disabled}
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex size-6 items-center justify-center rounded-full border border-current/20 bg-background/70 text-[11px] font-semibold">
          {SRS_REVIEW_SHORTCUTS[rating]}
        </span>
        <div>
          <p className="text-sm font-semibold tracking-tight">
            {getSrsReviewRatingLabel(rating)}
          </p>
          <p className="mt-1 text-xs text-current/75">
            {formatRelativeDue(scheduledDue)}
          </p>
        </div>
      </div>

      {isSubmitting ? <LoaderCircle className="mt-0.5 size-4 animate-spin" /> : null}
    </Button>
  );
}
