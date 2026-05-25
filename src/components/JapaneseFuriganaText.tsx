import { memo, useEffect, useMemo, useState } from 'react';
import { analyzeJapaneseText, type ReaderAnalysis } from '@/lib/japanese-reader';
import { cn } from '@/lib/utils';

const readerAnalysisCache = new Map<string, ReaderAnalysis>();
const readerAnalysisPromiseCache = new Map<string, Promise<ReaderAnalysis>>();

const normalizeReaderAnalysisCacheKey = (text: string) => text.replace(/\r\n?/g, '\n').trim();

const getCachedReaderAnalysis = (text: string) => {
  const cacheKey = normalizeReaderAnalysisCacheKey(text);

  return cacheKey ? readerAnalysisCache.get(cacheKey) ?? null : null;
};

const getReaderAnalysis = (text: string) => {
  const cacheKey = normalizeReaderAnalysisCacheKey(text);

  if (!cacheKey) {
    return Promise.resolve<ReaderAnalysis | null>(null);
  }

  const cachedAnalysis = readerAnalysisCache.get(cacheKey);

  if (cachedAnalysis) {
    return Promise.resolve(cachedAnalysis);
  }

  const cachedPromise = readerAnalysisPromiseCache.get(cacheKey);

  if (cachedPromise) {
    return cachedPromise;
  }

  const nextPromise = analyzeJapaneseText(text)
    .then((analysis) => {
      readerAnalysisCache.set(cacheKey, analysis);

      return analysis;
    })
    .finally(() => {
      readerAnalysisPromiseCache.delete(cacheKey);
    });

  readerAnalysisPromiseCache.set(cacheKey, nextPromise);

  return nextPromise;
};

function JapaneseFuriganaText({
  text,
  className,
  inline = false,
}: {
  text: string;
  className?: string;
  inline?: boolean;
}) {
  const normalizedAnalysisCacheKey = useMemo(
    () => normalizeReaderAnalysisCacheKey(text),
    [text],
  );
  const [analysis, setAnalysis] = useState<ReaderAnalysis | null>(() =>
    getCachedReaderAnalysis(text),
  );

  useEffect(() => {
    if (!normalizedAnalysisCacheKey) {
      setAnalysis(null);
      return;
    }

    const cachedAnalysis = readerAnalysisCache.get(normalizedAnalysisCacheKey) ?? null;

    if (cachedAnalysis) {
      setAnalysis(cachedAnalysis);
      return;
    }

    setAnalysis(null);

    let isCancelled = false;

    void getReaderAnalysis(text)
      .then((result) => {
        if (!isCancelled) {
          setAnalysis(result);
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setAnalysis(null);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [normalizedAnalysisCacheKey, text]);

  if (!analysis || analysis.lines.length === 0) {
    return inline ? (
      <span className={cn('whitespace-pre-wrap wrap-break-word', className)}>{text}</span>
    ) : (
      <div className={cn('whitespace-pre-wrap wrap-break-word', className)}>{text}</div>
    );
  }

  if (inline) {
    return (
      <span className={cn('whitespace-pre-wrap wrap-break-word', className)}>
        {analysis.lines.map((line, lineIndex) => (
          <span key={`${text.slice(0, 8)}:${lineIndex}`} className="leading-7">
            {line.map((token, tokenIndex) => {
              const tokenBody = token.hasKanji && token.readingHiragana ? (
                <ruby className="align-baseline [ruby-position:over]">
                  <span>{token.surface}</span>
                  <rt className="text-[0.62em] leading-none text-muted-foreground/90">
                    {token.readingHiragana}
                  </rt>
                </ruby>
              ) : (
                <span>{token.surface}</span>
              );

              return <span key={`${token.surface}:${tokenIndex}`}>{tokenBody}</span>;
            })}
            {lineIndex < analysis.lines.length - 1 ? <br /> : null}
          </span>
        ))}
      </span>
    );
  }

  return (
    <div className={cn('space-y-1 whitespace-pre-wrap wrap-break-word', className)}>
      {analysis.lines.map((line, lineIndex) => (
        <div key={`${text.slice(0, 8)}:${lineIndex}`} className="leading-7">
          {line.length === 0 ? <span>&nbsp;</span> : null}
          {line.map((token, tokenIndex) => {
            const tokenBody = token.hasKanji && token.readingHiragana ? (
              <ruby className="align-baseline [ruby-position:over]">
                <span>{token.surface}</span>
                <rt className="text-[0.62em] leading-none text-muted-foreground/90">
                  {token.readingHiragana}
                </rt>
              </ruby>
            ) : (
              <span>{token.surface}</span>
            );

            return <span key={`${token.surface}:${tokenIndex}`}>{tokenBody}</span>;
          })}
        </div>
      ))}
    </div>
  );
}

export default memo(
  JapaneseFuriganaText,
  (previousProps, nextProps) =>
    previousProps.text === nextProps.text &&
    previousProps.inline === nextProps.inline &&
    previousProps.className === nextProps.className,
);
