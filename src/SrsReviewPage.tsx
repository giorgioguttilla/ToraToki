import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, LoaderCircle, Trash2 } from 'lucide-react';
import JapaneseFuriganaText from '@/components/JapaneseFuriganaText';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type {
  CreateSrsItemInput,
  DeleteSrsItemResult,
  SrsReviewQueue,
  SubmitSrsReviewInput,
  SubmitSrsReviewResult,
  UpdateSrsItemInput,
  UpdateSrsItemResult,
} from '@/shared/language-api';
import {
  SRS_REVIEW_RATINGS,
  SRS_REVIEW_SHORTCUTS,
  getSrsReviewRatingLabel,
  type SrsReviewRating,
} from '@/shared/srs-review';
import {
  formatFrequency,
  formatJlptLevel,
  formatKanjiReadings,
  getKanjiDetailsForText,
  type KanjiReference,
} from '@/lib/kanji-reference';
import { analyzeJapaneseText, type ReaderToken } from '@/lib/japanese-reader';
import {
  KEY_TO_REVIEW_RATING,
  ReviewRatingButton,
  formatAbsoluteDateTime,
  formatRelativeDue,
} from '@/srs/review-ui';
import { getPreferredSrsItemText } from '@/srs/item-text';

const toErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const joinSrsAnswerLines = (lines: Array<string | null | undefined>) =>
  lines
    .map((line) => line?.trim() ?? '')
    .filter((line) => line.length > 0)
    .join('\n');

const collectTopTokenDefinitions = (tokens: ReaderToken[]) => {
  const entriesById = new Map<number, { headword: string; reading: string | null; meanings: string[] }>();

  for (const token of tokens) {
    const firstDefinition = token.definitions[0];

    if (!firstDefinition || entriesById.has(firstDefinition.entSeq)) {
      continue;
    }

    entriesById.set(firstDefinition.entSeq, {
      headword: firstDefinition.headword,
      reading: firstDefinition.reading,
      meanings: firstDefinition.meanings,
    });
  }

  return [...entriesById.values()];
};

const buildKanjiAnswerDump = (kanjiDetails: KanjiReference[]) =>
  joinSrsAnswerLines(
    kanjiDetails.flatMap((kanji, index) => [
      `${kanji.literal}`,
      kanji.meanings.length > 0 ? `Meanings: ${kanji.meanings.join(' • ')}` : 'Meanings: —',
      `Onyomi: ${formatKanjiReadings(kanji.onyomi)}`,
      `Kunyomi: ${formatKanjiReadings(kanji.kunyomi)}`,
      `JLPT: ${formatJlptLevel(kanji.jlpt)}`,
      `Commonality: ${formatFrequency(kanji.freq)}`,
      index < kanjiDetails.length - 1 ? '' : null,
    ]),
  );

function VocabKanjiInfoGrid({ kanjiDetails }: { kanjiDetails: KanjiReference[] }) {
  if (kanjiDetails.length === 0) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-border/60 bg-background/70 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Key kanji
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {kanjiDetails.map((kanji) => (
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
  );
}

export default function SrsReviewPage({
  onBack,
  createItem,
  updateItem,
  deleteItem,
  loadReviewQueue,
  submitReview,
}: {
  onBack: () => void;
  createItem: (input: CreateSrsItemInput) => Promise<void>;
  updateItem: (input: UpdateSrsItemInput) => Promise<UpdateSrsItemResult>;
  deleteItem: (itemId: string) => Promise<DeleteSrsItemResult>;
  loadReviewQueue: () => Promise<SrsReviewQueue>;
  submitReview: (input: SubmitSrsReviewInput) => Promise<SubmitSrsReviewResult>;
}) {
  const [queue, setQueue] = useState<SrsReviewQueue | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isAddCardOpen, setIsAddCardOpen] = useState(false);
  const [isAddingCard, setIsAddingCard] = useState(false);
  const [isAutoFillingAddCardAnswer, setIsAutoFillingAddCardAnswer] = useState(false);
  const [addCardMessage, setAddCardMessage] = useState<string | null>(null);
  const [isAddCardError, setIsAddCardError] = useState(false);
  const [newCardItem, setNewCardItem] = useState('');
  const [newCardAnswer, setNewCardAnswer] = useState('');
  const [newCardCategory, setNewCardCategory] = useState<CreateSrsItemInput['category']>('vocab');
  const [isEditCardOpen, setIsEditCardOpen] = useState(false);
  const [isEditingCard, setIsEditingCard] = useState(false);
  const [editCardMessage, setEditCardMessage] = useState<string | null>(null);
  const [isEditCardError, setIsEditCardError] = useState(false);
  const [editCardItem, setEditCardItem] = useState('');
  const [editCardAnswer, setEditCardAnswer] = useState('');
  const [isAnswerVisible, setIsAnswerVisible] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const currentCard = queue?.current ?? null;
  const currentCardPromptText = currentCard ? getPreferredSrsItemText(currentCard) : null;
  const currentCardKanjiDetails = useMemo(
    () => (currentCard?.category === 'vocab' ? getKanjiDetailsForText(currentCard.item) : []),
    [currentCard?.category, currentCard?.item],
  );
  const nextDueLabel = useMemo(
    () => (queue?.nextDueAt ? formatAbsoluteDateTime(queue.nextDueAt) : null),
    [queue?.nextDueAt],
  );

  const handleLoadQueue = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const nextQueue = await loadReviewQueue();
      setQueue(nextQueue);
    } catch (error) {
      setErrorMessage(toErrorMessage(error, 'Unable to load the SRS review queue.'));
    } finally {
      setIsLoading(false);
    }
  }, [loadReviewQueue]);

  useEffect(() => {
    void handleLoadQueue();
  }, [handleLoadQueue]);

  useEffect(() => {
    setIsAnswerVisible(false);
    setIsConfirmingDelete(false);
    setIsEditCardOpen(false);
    setEditCardMessage(null);
    setIsEditCardError(false);
    setEditCardItem(currentCard?.item ?? '');
    setEditCardAnswer(currentCard?.answer ?? '');
  }, [currentCard?.id]);

  const handleRevealAnswer = useCallback(() => {
    if (!currentCard || isAnswerVisible) {
      return;
    }

    setIsAnswerVisible(true);
  }, [currentCard, isAnswerVisible]);

  const handleSubmitRating = useCallback(
    async (rating: SrsReviewRating) => {
      if (!currentCard || !isAnswerVisible || isSubmitting || isDeleting) {
        return;
      }

      setIsSubmitting(true);
      setErrorMessage(null);

      try {
        const result = await submitReview({
          itemId: currentCard.id,
          rating,
        });
        setQueue(result.queue);
      } catch (error) {
        setErrorMessage(toErrorMessage(error, 'Unable to submit the SRS review.'));
      } finally {
        setIsSubmitting(false);
      }
    },
    [currentCard, isAnswerVisible, isDeleting, isSubmitting, submitReview],
  );

  const handleDeleteCurrentCard = useCallback(async () => {
    if (!currentCard || isDeleting || isSubmitting) {
      return;
    }

    setIsDeleting(true);
    setErrorMessage(null);

    try {
      const result = await deleteItem(currentCard.id);
      setQueue(result.queue);
    } catch (error) {
      setErrorMessage(toErrorMessage(error, 'Unable to delete the SRS card.'));
    } finally {
      setIsDeleting(false);
    }
  }, [currentCard, deleteItem, isDeleting, isSubmitting]);

  const handleCreateCard = useCallback(async () => {
    if (isAddingCard) {
      return;
    }

    const item = newCardItem.trim();
    const answer = newCardAnswer.trim();

    if (!item || !answer) {
      setIsAddCardError(true);
      setAddCardMessage('Both item and answer are required.');
      return;
    }

    setIsAddingCard(true);
    setIsAddCardError(false);
    setAddCardMessage(null);

    try {
      await createItem({
        item,
        answer,
        category: newCardCategory,
      });

      setNewCardItem('');
      setNewCardAnswer('');
      setAddCardMessage('Card added to SRS.');
      await handleLoadQueue();
    } catch (error) {
      setIsAddCardError(true);
      setAddCardMessage(toErrorMessage(error, 'Unable to create the SRS card.'));
    } finally {
      setIsAddingCard(false);
    }
  }, [createItem, handleLoadQueue, isAddingCard, newCardAnswer, newCardCategory, newCardItem]);

  const handleAutoFillAddCardAnswer = useCallback(
    async (nextCategory?: CreateSrsItemInput['category']) => {
      if (isAutoFillingAddCardAnswer) {
        return;
      }

      const category = nextCategory ?? newCardCategory;
      const item = newCardItem.trim();

      if (!item) {
        setIsAddCardError(true);
        setAddCardMessage('Enter item text first to auto-fill the answer.');
        return;
      }

      setIsAutoFillingAddCardAnswer(true);
      setIsAddCardError(false);
      setAddCardMessage(null);

      try {
        if (category === 'kanji') {
          const kanjiDetails = getKanjiDetailsForText(item);

          if (kanjiDetails.length === 0) {
            throw new Error('No kanji details found for this text.');
          }

          setNewCardAnswer(buildKanjiAnswerDump(kanjiDetails));
          setAddCardMessage('Answer auto-filled with kanji details.');

          return;
        }

        if (category === 'vocab' || category === 'sentence') {
          const analysis = await analyzeJapaneseText(item);
          const tokens = analysis.lines.flat().filter((token) => token.partOfSpeech !== '記号');
          const reading = tokens
            .map((token) => token.readingHiragana ?? token.surface)
            .join('')
            .trim();

          const fullTextEntries = await window.languageApp.dictionary.lookupEntries({
            surfaceForm: item,
            basicForm: item,
            reading: reading || null,
            partOfSpeech: null,
          });
          const selectedEntries =
            fullTextEntries.length > 0
              ? fullTextEntries.slice(0, 4).map((entry) => ({
                  headword: entry.headword,
                  reading: entry.reading,
                  meanings: entry.meanings,
                }))
              : collectTopTokenDefinitions(tokens).slice(0, 6);

          const answer =
            joinSrsAnswerLines([
              reading ? `Reading: ${reading}` : null,
              selectedEntries.length > 0 ? 'Meanings:' : null,
              ...selectedEntries.map((entry, index) =>
                `${index + 1}. ${entry.headword}${entry.reading ? ` (${entry.reading})` : ''}: ${entry.meanings.slice(0, 4).join(' • ')}`,
              ),
            ]) || 'No dictionary gloss available.';

          setNewCardAnswer(answer);
          setAddCardMessage('Answer auto-filled from dictionary data.');

          return;
        }

        setAddCardMessage('Auto-fill is currently available for vocab, sentence, and kanji cards.');
      } catch (error) {
        setIsAddCardError(true);
        setAddCardMessage(toErrorMessage(error, 'Unable to auto-fill the answer.'));
      } finally {
        setIsAutoFillingAddCardAnswer(false);
      }
    },
    [isAutoFillingAddCardAnswer, newCardCategory, newCardItem],
  );

  const handleUpdateCard = useCallback(async () => {
    if (!currentCard || isEditingCard) {
      return;
    }

    const item = editCardItem.trim();
    const answer = editCardAnswer.trim();

    if (!item || !answer) {
      setIsEditCardError(true);
      setEditCardMessage('Both item and answer are required.');
      return;
    }

    setIsEditingCard(true);
    setIsEditCardError(false);
    setEditCardMessage(null);

    try {
      const result = await updateItem({
        itemId: currentCard.id,
        item,
        answer,
      });

      setQueue(result.queue);
      setEditCardItem(result.updatedItem.item);
      setEditCardAnswer(result.updatedItem.answer);
      setEditCardMessage('Card updated.');
    } catch (error) {
      setIsEditCardError(true);
      setEditCardMessage(toErrorMessage(error, 'Unable to update the SRS card.'));
    } finally {
      setIsEditingCard(false);
    }
  }, [currentCard, editCardAnswer, editCardItem, isEditingCard, updateItem]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;

      if (
        target?.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }

      if (event.code === 'Space') {
        if (!currentCard || isAnswerVisible) {
          return;
        }

        event.preventDefault();
        setIsAnswerVisible(true);
        return;
      }

      if (!currentCard || !isAnswerVisible) {
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
  }, [currentCard, handleSubmitRating, isAnswerVisible]);

  return (
    <main className="box-border h-screen overflow-hidden bg-background p-4 sm:p-6">
      <div className="mx-auto flex h-full w-full max-w-4xl items-center justify-center">
        <Card className="flex h-full max-h-full w-full flex-col overflow-hidden border-border/60">
          <CardHeader className="shrink-0 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>SRS review</CardTitle>
                <CardDescription>
                  Review due cards one at a time, then rate recall with 1–4.
                </CardDescription>
              </div>
              <Button type="button" variant="ghost" size="icon" aria-label="Back" onClick={onBack}>
                <ArrowLeft className="size-5" />
              </Button>
            </div>

            <div className="flex min-h-8 flex-wrap items-center gap-2">
              <Badge variant="outline">Due now {queue?.dueCount ?? 0}</Badge>
              {queue?.nextDueAt ? (
                <Badge variant="outline">Next {formatRelativeDue(queue.nextDueAt)}</Badge>
              ) : null}
              {currentCard ? <Badge variant="secondary">{currentCard.category}</Badge> : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => {
                  setIsAddCardOpen((current) => !current);
                  setIsEditCardOpen(false);
                  setAddCardMessage(null);
                  setIsAddCardError(false);
                }}
                disabled={isAddingCard || isEditingCard}
              >
                {isAddCardOpen ? 'Close add card' : 'Add card'}
              </Button>
              {currentCard ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => {
                    setIsEditCardOpen((current) => !current);
                    setIsAddCardOpen(false);
                    setEditCardMessage(null);
                    setIsEditCardError(false);
                    setEditCardItem(currentCard.item);
                    setEditCardAnswer(currentCard.answer);
                  }}
                  disabled={isAddingCard || isEditingCard}
                >
                  {isEditCardOpen ? 'Close edit card' : 'Edit card'}
                </Button>
              ) : null}
              {currentCard ? (
                <div className="ml-auto flex h-8 items-center gap-2">
                  {isConfirmingDelete ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => {
                          setIsConfirmingDelete(false);
                        }}
                        disabled={isDeleting || isSubmitting}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => {
                          void handleDeleteCurrentCard();
                        }}
                        disabled={isDeleting || isSubmitting}
                      >
                        {isDeleting ? (
                          <>
                            <LoaderCircle className="mr-1 size-3 animate-spin" />
                            Deleting…
                          </>
                        ) : (
                          'Delete'
                        )}
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
                      aria-label="Delete this SRS card"
                      onClick={() => {
                        setIsConfirmingDelete(true);
                      }}
                      disabled={isDeleting || isSubmitting}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          </CardHeader>

          <CardContent className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden">
            {isAddCardOpen ? (
              <div className="shrink-0 rounded-2xl border border-border/60 bg-muted/10 p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Add SRS card
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="text-xs text-muted-foreground sm:col-span-1">
                    Category
                    <select
                      className="mt-1 h-9 w-full rounded-lg border border-border/60 bg-background px-2 text-sm text-foreground outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
                      value={newCardCategory}
                      onChange={(event) => {
                        const nextCategory = event.target.value as CreateSrsItemInput['category'];
                        setNewCardCategory(nextCategory);

                        if (newCardAnswer.trim().length === 0 && newCardItem.trim().length > 0) {
                          void handleAutoFillAddCardAnswer(nextCategory);
                        }
                      }}
                      disabled={isAddingCard || isAutoFillingAddCardAnswer}
                    >
                      <option value="kanji">Kanji</option>
                      <option value="vocab">Vocab</option>
                      <option value="sentence">Sentence</option>
                      <option value="translate">Translate</option>
                      <option value="correction">Correction</option>
                    </select>
                  </label>

                  <div className="hidden sm:block" />

                  <label className="text-xs text-muted-foreground sm:col-span-2">
                    Item
                    <textarea
                      className="mt-1 min-h-16 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
                      value={newCardItem}
                      onChange={(event) => {
                        setNewCardItem(event.target.value);
                      }}
                      onBlur={() => {
                        if (newCardAnswer.trim().length === 0 && newCardItem.trim().length > 0) {
                          void handleAutoFillAddCardAnswer();
                        }
                      }}
                      placeholder="Prompt text"
                      disabled={isAddingCard || isAutoFillingAddCardAnswer}
                    />
                  </label>

                  <label className="text-xs text-muted-foreground sm:col-span-2">
                    Answer
                    <textarea
                      className="mt-1 min-h-16 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
                      value={newCardAnswer}
                      onChange={(event) => {
                        setNewCardAnswer(event.target.value);
                      }}
                      placeholder="Answer text"
                      disabled={isAddingCard}
                    />
                  </label>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className={cn('text-xs', isAddCardError ? 'text-destructive' : 'text-muted-foreground')}>
                    {addCardMessage ?? 'You can keep adding cards while reviews are pending.'}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void handleAutoFillAddCardAnswer();
                      }}
                      disabled={isAutoFillingAddCardAnswer || isAddingCard}
                    >
                      {isAutoFillingAddCardAnswer ? (
                        <>
                          <LoaderCircle className="mr-2 size-4 animate-spin" />
                          Filling…
                        </>
                      ) : (
                        'Auto-fill answer'
                      )}
                    </Button>

                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        void handleCreateCard();
                      }}
                      disabled={isAddingCard || isAutoFillingAddCardAnswer}
                    >
                      {isAddingCard ? (
                        <>
                          <LoaderCircle className="mr-2 size-4 animate-spin" />
                          Saving…
                        </>
                      ) : (
                        'Save card'
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

            {isEditCardOpen && currentCard ? (
              <div className="shrink-0 rounded-2xl border border-border/60 bg-muted/10 p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Edit current card
                </p>
                <div className="mt-3 grid gap-3">
                  <label className="text-xs text-muted-foreground">
                    Item
                    <textarea
                      className="mt-1 min-h-16 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
                      value={editCardItem}
                      onChange={(event) => {
                        setEditCardItem(event.target.value);
                      }}
                      placeholder="Prompt text"
                      disabled={isEditingCard}
                    />
                  </label>

                  <label className="text-xs text-muted-foreground">
                    Answer
                    <textarea
                      className="mt-1 min-h-16 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary/40 focus:ring-4 focus:ring-primary/10"
                      value={editCardAnswer}
                      onChange={(event) => {
                        setEditCardAnswer(event.target.value);
                      }}
                      placeholder="Answer text"
                      disabled={isEditingCard}
                    />
                  </label>
                </div>

                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className={cn('text-xs', isEditCardError ? 'text-destructive' : 'text-muted-foreground')}>
                    {editCardMessage ?? 'Update text for this card without leaving review.'}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      void handleUpdateCard();
                    }}
                    disabled={isEditingCard}
                  >
                    {isEditingCard ? (
                      <>
                        <LoaderCircle className="mr-2 size-4 animate-spin" />
                        Saving…
                      </>
                    ) : (
                      'Save changes'
                    )}
                  </Button>
                </div>
              </div>
            ) : null}

            {errorMessage ? (
              <div className="shrink-0 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {errorMessage}
              </div>
            ) : null}

            {isLoading ? (
              <div className="flex min-h-0 flex-1 items-center justify-center rounded-3xl border border-border/60 bg-muted/20 px-4 py-10 text-sm text-muted-foreground">
                <LoaderCircle className="mr-2 size-4 animate-spin" />
                Loading review queue…
              </div>
            ) : currentCard ? (
              <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-3 overflow-hidden">
                <button
                  type="button"
                  className={cn(
                    'grid h-full min-h-0 w-full grid-rows-[auto_minmax(0,1fr)_auto] rounded-[2rem] border border-border/60 bg-muted/20 px-6 py-6 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:px-8 sm:py-7',
                    !isAnswerVisible && 'hover:bg-muted/30',
                  )}
                  onClick={handleRevealAnswer}
                  disabled={isSubmitting || isDeleting}
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    {isAnswerVisible ? 'Answer' : 'Prompt'}
                  </p>
                  <div className="mt-5 min-h-0 overflow-y-auto whitespace-pre-wrap wrap-break-word text-xl font-semibold leading-9 text-foreground sm:text-2xl">
                    {isAnswerVisible ? (
                      currentCard.category === 'sentence' ? (
                        <div className="space-y-4 text-base font-medium leading-8 sm:text-lg">
                          <p className="whitespace-pre-wrap wrap-break-word text-xl font-semibold leading-9 text-foreground sm:text-2xl">
                            {currentCard.answer}
                          </p>

                          <div className="rounded-2xl border border-border/60 bg-background/70 px-4 py-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                              Japanese sentence
                            </p>
                            <JapaneseFuriganaText
                              text={currentCard.item}
                              className="mt-3 text-lg font-medium leading-8 text-foreground sm:text-xl"
                            />
                          </div>
                        </div>
                      ) : currentCard.category === 'kanji' || currentCard.category === 'vocab' ? (
                        <div className="space-y-4 text-base font-medium leading-8 sm:text-lg">
                          <div className="rounded-2xl border border-border/60 bg-background/70 px-4 py-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                              Japanese
                            </p>
                            <JapaneseFuriganaText
                              text={currentCard.item}
                              className="mt-3 text-lg font-medium leading-8 text-foreground sm:text-xl"
                            />
                          </div>

                          <p className="whitespace-pre-wrap wrap-break-word text-xl font-semibold leading-9 text-foreground sm:text-2xl">
                            {currentCard.answer}
                          </p>

                          {currentCard.category === 'vocab' ? (
                            <VocabKanjiInfoGrid kanjiDetails={currentCardKanjiDetails} />
                          ) : null}
                        </div>
                      ) : (
                        currentCard.answer
                      )
                    ) : (
                      currentCardPromptText
                    )}
                  </div>
                  {!isAnswerVisible ? (
                    <div className="mt-4 flex items-end text-sm text-muted-foreground">
                      <p>Click the card or press Space to reveal the answer.</p>
                    </div>
                  ) : null}
                </button>

                <div className="rounded-3xl border border-border/60 bg-background/40 p-2">
                  {isAnswerVisible ? (
                    <div className="flex flex-col gap-2">
                      <div className="grid grid-cols-4 gap-2">
                        {queue?.ratingPreviews.map((preview) => (
                          <ReviewRatingButton
                            key={preview.rating}
                            disabled={isSubmitting || isDeleting}
                            isSubmitting={isSubmitting || isDeleting}
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
            ) : (
              <div className="flex min-h-0 flex-1 flex-col rounded-3xl border border-border/60 bg-muted/20 p-6">
                <div className="flex-1">
                  <p className="text-lg font-semibold tracking-tight text-foreground">
                    No cards are due right now.
                  </p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {nextDueLabel
                      ? `The next review is ${nextDueLabel}. Add cards from chats or come back then.`
                      : 'There are no scheduled reviews yet. Add cards from chats, then come back here.'}
                  </p>
                </div>

                {queue?.nextDueAt ? (
                  <div className="rounded-2xl border border-border/60 bg-background/80 px-4 py-3 text-sm text-muted-foreground">
                    Next review {formatRelativeDue(queue.nextDueAt)}.
                  </div>
                ) : null}

                <div className="flex justify-end">
                  <Button type="button" variant="outline" onClick={() => {
                    void handleLoadQueue();
                  }} disabled={isLoading}>
                    Refresh queue
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
