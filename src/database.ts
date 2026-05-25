import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import type {
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  CreateSrsItemInput,
  DeleteSrsItemResult,
  DictionaryEntry,
  DictionaryLookupQuery,
  DictionaryStatus,
  ListDueSrsItemsInput,
  SaveChatSessionInput,
  SrsCategory,
  SrsClearResult,
  SrsExportResult,
  SrsItem,
  SrsReviewQueue,
  SrsStats,
  SubmitSrsReviewInput,
  SubmitSrsReviewResult,
  UpdateSrsItemInput,
  UpdateSrsItemResult,
} from './shared/language-api';
import {
  SRS_REVIEW_RATINGS,
  type SrsReviewRating,
} from './shared/srs-review';
import type {
  JmdictDb,
  JmdictModule,
  JmdictTagMap,
  JmdictWord,
} from './jmdict-types';
import {
  FSRS_NEW_STATE,
  applyFsrsReview,
  createInitialFsrsCard,
  fsrsStateLabel,
  previewFsrsReviews,
  serializeFsrsCard,
} from './srs/fsrs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const jmdictSimplified = require('jmdict-simplified-node') as JmdictModule;

const {
  getField,
  getTags,
  kanjiBeginning,
  readingBeginning,
  setup,
} = jmdictSimplified;

const APP_META_SCHEMA = `
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const CHAT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_session (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    history_json JSON NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS chat_session_updated_idx
    ON chat_session(updated_at DESC);
`;

const SRS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS srs_item (
    id TEXT PRIMARY KEY,
    item TEXT NOT NULL,
    answer TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('kanji', 'vocab', 'sentence', 'translate', 'correction')),
    source_entry_id INTEGER,
    created_time TEXT NOT NULL,
    last_updated_time TEXT NOT NULL,
    due TEXT NOT NULL,
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    elapsed_days INTEGER NOT NULL DEFAULT 0,
    scheduled_days INTEGER NOT NULL DEFAULT 0,
    learning_steps INTEGER NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    state INTEGER NOT NULL DEFAULT 0,
    last_review TEXT
  );

  CREATE INDEX IF NOT EXISTS srs_item_due_idx
    ON srs_item(due);

  CREATE INDEX IF NOT EXISTS srs_item_category_idx
    ON srs_item(category);

  CREATE INDEX IF NOT EXISTS srs_item_state_idx
    ON srs_item(state);

  CREATE UNIQUE INDEX IF NOT EXISTS srs_item_unique_kanji_idx
    ON srs_item(category, item)
    WHERE category = 'kanji';

  CREATE UNIQUE INDEX IF NOT EXISTS srs_item_unique_vocab_source_entry_idx
    ON srs_item(category, source_entry_id)
    WHERE category = 'vocab' AND source_entry_id IS NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS srs_item_unique_vocab_text_fallback_idx
    ON srs_item(category, item)
    WHERE category = 'vocab' AND source_entry_id IS NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS srs_item_unique_sentence_idx
    ON srs_item(category, item)
    WHERE category = 'sentence';

  CREATE UNIQUE INDEX IF NOT EXISTS srs_item_unique_correction_idx
    ON srs_item(category, item)
    WHERE category = 'correction';
`;

interface DatabaseInitOptions {
  userDataPath: string;
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
}

interface JmdictRuntime {
  db: JmdictDb;
  tags: JmdictTagMap;
  version: string | null;
  dictDate: string | null;
}

interface SearchTarget {
  value: string;
  kind: 'text' | 'reading';
  priority: number;
}

interface WordMatch {
  word: JmdictWord;
  target: SearchTarget;
  exactness: number;
  partOfSpeechPenalty: number;
  matchedFormPenalty: number;
  commonnessPenalty: number;
  lengthPenalty: number;
}

interface ChatSessionRow {
  id: string;
  title: string;
  history_json: string;
  created_at: string;
  updated_at: string;
}

interface ChatSessionSummaryRow {
  id: string;
  title: string;
  history_json: string;
  updated_at: string;
}

interface SrsItemRow {
  id: string;
  item: string;
  answer: string;
  category: SrsCategory;
  source_entry_id: number | null;
  created_time: string;
  last_updated_time: string;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: string | null;
}

interface LegacyReviewItemRow {
  id: number;
  prompt: string;
  answer: string;
  next_due_at: string | null;
  interval_days: number | null;
  created_at: string | null;
  updated_at: string | null;
}

interface SrsStatsRow {
  due_now: number | null;
  new_cards: number | null;
  total_tracked: number;
}

const SRS_CATEGORY_VALUES: SrsCategory[] = ['kanji', 'vocab', 'sentence', 'translate', 'correction'];
const SRS_REVIEW_CATEGORY_PRIORITY_SQL = `
  CASE category
    WHEN 'sentence' THEN 0
    WHEN 'correction' THEN 1
    WHEN 'vocab' THEN 2
    WHEN 'kanji' THEN 3
    ELSE 4
  END
`;

const KUROMOJI_PART_OF_SPEECH_HINTS: Record<string, RegExp[]> = {
  名詞: [/\bnoun\b/i],
  動詞: [/\bverb\b/i],
  形容詞: [/adjective/i],
  副詞: [/adverb/i],
  連体詞: [/pre-noun|pre-nominal/i],
  助詞: [/particle/i],
  助動詞: [/auxiliary verb/i],
  接続詞: [/conjunction/i],
  感動詞: [/interjection/i],
  接頭詞: [/prefix/i],
};

const createDatabase = (filePath: string, namespace: string) => {
  const database = new Database(filePath);

  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(APP_META_SCHEMA);

  const upsertMeta = database.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  upsertMeta.run({ key: 'namespace', value: namespace });
  upsertMeta.run({ key: 'initialized_at', value: new Date().toISOString() });

  return database;
};

type SqliteDatabase = ReturnType<typeof createDatabase>;

let srsDatabase: SqliteDatabase | null = null;
let chatsDatabase: SqliteDatabase | null = null;
let jmdictRuntime: JmdictRuntime | null = null;
let jmdictInitializationStarted = false;
const kuromojiFileCache = new Map<string, ArrayBuffer>();
const srsEventEmitter = new EventEmitter();
let dictionaryStatus: DictionaryStatus = {
  state: 'missing',
  source: 'jmdict',
  version: null,
  dictDate: null,
  detail:
    'Bundled JMdict JSON was not found yet. Run `npm run dictionary:bundle` to add it before packaging.',
};

const initializeSrsStorage = (database: SqliteDatabase) => {
  const existingSrsColumns = database
    .prepare("PRAGMA table_info('srs_item')")
    .all() as Array<{ name: string }>;
  const hasLegacySrsSchema =
    existingSrsColumns.length > 0 &&
    !existingSrsColumns.some((column) => column.name === 'source_entry_id');

  if (hasLegacySrsSchema) {
    throw new Error(
      'Existing SRS data uses an older schema. Clear the SRS database manually before restarting the app.',
    );
  }

  const existingSrsTableDefinition = database
    .prepare(
      `
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table' AND name = 'srs_item'
      `,
    )
    .get() as { sql: string | null } | undefined;

  const requiresCorrectionCategoryMigration =
    typeof existingSrsTableDefinition?.sql === 'string' &&
    !existingSrsTableDefinition.sql.includes("'correction'");

  if (requiresCorrectionCategoryMigration) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE srs_item_migrated (
          id TEXT PRIMARY KEY,
          item TEXT NOT NULL,
          answer TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN ('kanji', 'vocab', 'sentence', 'translate', 'correction')),
          source_entry_id INTEGER,
          created_time TEXT NOT NULL,
          last_updated_time TEXT NOT NULL,
          due TEXT NOT NULL,
          stability REAL NOT NULL,
          difficulty REAL NOT NULL,
          elapsed_days INTEGER NOT NULL DEFAULT 0,
          scheduled_days INTEGER NOT NULL DEFAULT 0,
          learning_steps INTEGER NOT NULL DEFAULT 0,
          reps INTEGER NOT NULL DEFAULT 0,
          lapses INTEGER NOT NULL DEFAULT 0,
          state INTEGER NOT NULL DEFAULT 0,
          last_review TEXT
        );

        INSERT INTO srs_item_migrated (
          id,
          item,
          answer,
          category,
          source_entry_id,
          created_time,
          last_updated_time,
          due,
          stability,
          difficulty,
          elapsed_days,
          scheduled_days,
          learning_steps,
          reps,
          lapses,
          state,
          last_review
        )
        SELECT
          id,
          item,
          answer,
          category,
          source_entry_id,
          created_time,
          last_updated_time,
          due,
          stability,
          difficulty,
          elapsed_days,
          scheduled_days,
          learning_steps,
          reps,
          lapses,
          state,
          last_review
        FROM srs_item;

        DROP TABLE srs_item;
        ALTER TABLE srs_item_migrated RENAME TO srs_item;
      `);
    })();
  }

  try {
    database.exec(SRS_SCHEMA);
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    throw new Error(
      'Existing SRS data conflicts with the current duplicate-blocking rules. Clear the SRS database manually before restarting the app.',
    );
  }

  const legacyTable = database
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'review_item'
      `,
    )
    .get() as { name: string } | undefined;

  if (!legacyTable) {
    return;
  }

  const existingSrsCount = database
    .prepare('SELECT COUNT(*) AS total FROM srs_item')
    .get() as { total: number };

  if (existingSrsCount.total > 0) {
    return;
  }

  const legacyRows = database
    .prepare(
      `
        SELECT id, prompt, answer, next_due_at, interval_days, created_at, updated_at
        FROM review_item
        ORDER BY id ASC
      `,
    )
    .all() as LegacyReviewItemRow[];

  if (legacyRows.length === 0) {
    return;
  }

  const insertLegacyItem = database.prepare(`
    INSERT INTO srs_item (
      id,
      item,
      answer,
      category,
      source_entry_id,
      created_time,
      last_updated_time,
      due,
      stability,
      difficulty,
      elapsed_days,
      scheduled_days,
      learning_steps,
      reps,
      lapses,
      state,
      last_review
    ) VALUES (
      @id,
      @item,
      @answer,
      @category,
      @sourceEntryId,
      @createdTime,
      @lastUpdatedTime,
      @due,
      @stability,
      @difficulty,
      @elapsedDays,
      @scheduledDays,
      @learningSteps,
      @reps,
      @lapses,
      @state,
      @lastReview
    )
  `);

  const migrateLegacyItems = database.transaction((rows: LegacyReviewItemRow[]) => {
    for (const row of rows) {
      const createdTime = row.created_at ?? new Date().toISOString();
      const lastUpdatedTime = row.updated_at ?? createdTime;
      const initialCard = serializeFsrsCard(createInitialFsrsCard(new Date(createdTime)));

      insertLegacyItem.run({
        id: randomUUID(),
        item: row.prompt,
        answer: row.answer,
        category: 'translate',
        sourceEntryId: null,
        createdTime,
        lastUpdatedTime,
        due: row.next_due_at ?? initialCard.due,
        stability: initialCard.stability,
        difficulty: initialCard.difficulty,
        elapsedDays: initialCard.elapsedDays,
        scheduledDays:
          typeof row.interval_days === 'number'
            ? Math.max(0, Math.round(row.interval_days))
            : initialCard.scheduledDays,
        learningSteps: initialCard.learningSteps,
        reps: initialCard.reps,
        lapses: initialCard.lapses,
        state: initialCard.state,
        lastReview: initialCard.lastReview,
      });
    }
  });

  migrateLegacyItems(legacyRows);
};

const initializeChatsStorage = (database: SqliteDatabase) => {
  database.exec(CHAT_SCHEMA);
};

const hasTable = (database: SqliteDatabase, tableName: string) =>
  Boolean(
    database
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = ?
        `,
      )
      .get(tableName),
  );

const ensureSrsDatabase = () => {
  if (!srsDatabase) {
    throw new Error('SRS database is not initialized.');
  }

  return srsDatabase;
};

const isSrsCategory = (value: string): value is SrsCategory =>
  SRS_CATEGORY_VALUES.includes(value as SrsCategory);

const normalizeSrsCategory = (value: string): SrsCategory =>
  isSrsCategory(value) ? value : 'translate';

const normalizeSrsCategoryFilters = (categories?: SrsCategory[]) =>
  categories
    ? [...new Set(categories.filter((category) => isSrsCategory(category)))]
    : [];

const normalizeSourceEntryId = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;

const isSrsReviewRating = (value: string): value is SrsReviewRating =>
  SRS_REVIEW_RATINGS.includes(value as SrsReviewRating);

const toPersistedFsrsCardFields = (row: SrsItemRow) => ({
  due: row.due,
  stability: row.stability,
  difficulty: row.difficulty,
  elapsedDays: row.elapsed_days,
  scheduledDays: row.scheduled_days,
  learningSteps: row.learning_steps,
  reps: row.reps,
  lapses: row.lapses,
  state: row.state,
  lastReview: row.last_review,
});

const toSrsItem = (row: SrsItemRow): SrsItem => ({
  id: row.id,
  item: row.item,
  answer: row.answer,
  category: row.category,
  sourceEntryId: row.source_entry_id,
  createdTime: row.created_time,
  lastUpdatedTime: row.last_updated_time,
  due: row.due,
  stability: row.stability,
  difficulty: row.difficulty,
  elapsedDays: row.elapsed_days,
  scheduledDays: row.scheduled_days,
  learningSteps: row.learning_steps,
  reps: row.reps,
  lapses: row.lapses,
  state: row.state,
  lastReview: row.last_review,
});

const getSrsItemRow = (itemId: string): SrsItemRow | null => {
  const database = ensureSrsDatabase();
  const row = database
    .prepare(
      `
        SELECT
          id,
          item,
          answer,
          category,
          source_entry_id,
          created_time,
          last_updated_time,
          due,
          stability,
          difficulty,
          elapsed_days,
          scheduled_days,
          learning_steps,
          reps,
          lapses,
          state,
          last_review
        FROM srs_item
        WHERE id = ?
      `,
    )
    .get(itemId) as SrsItemRow | undefined;

  return row ?? null;
};

const getNextDueSrsItemRow = (nowIso: string): SrsItemRow | null => {
  const database = ensureSrsDatabase();
  const row = database
    .prepare(
      `
        SELECT
          id,
          item,
          answer,
          category,
          source_entry_id,
          created_time,
          last_updated_time,
          due,
          stability,
          difficulty,
          elapsed_days,
          scheduled_days,
          learning_steps,
          reps,
          lapses,
          state,
          last_review
        FROM srs_item
        WHERE due <= @nowIso
        ORDER BY
          ${SRS_REVIEW_CATEGORY_PRIORITY_SQL} ASC,
          datetime(due) ASC,
          datetime(created_time) ASC,
          rowid ASC
        LIMIT 1
      `,
    )
    .get({ nowIso }) as SrsItemRow | undefined;

  return row ?? null;
};

const listDueSrsItemRows = ({
  categories,
  nowIso,
}: {
  categories?: SrsCategory[];
  nowIso: string;
}) => {
  const database = ensureSrsDatabase();
  const normalizedCategories = normalizeSrsCategoryFilters(categories);
  const bindings: Record<string, string> = { nowIso };
  let query = `
    SELECT
      id,
      item,
      answer,
      category,
      source_entry_id,
      created_time,
      last_updated_time,
      due,
      stability,
      difficulty,
      elapsed_days,
      scheduled_days,
      learning_steps,
      reps,
      lapses,
      state,
      last_review
    FROM srs_item
    WHERE due <= @nowIso
  `;

  if (normalizedCategories.length > 0) {
    const placeholders = normalizedCategories.map((category, index) => {
      const bindingKey = `category${index}`;
      bindings[bindingKey] = category;

      return `@${bindingKey}`;
    });

    query += `
      AND category IN (${placeholders.join(', ')})
    `;
  }

  query += `
    ORDER BY
      datetime(due) ASC,
      datetime(created_time) ASC,
      rowid ASC
  `;

  return database.prepare(query).all(bindings) as SrsItemRow[];
};

const getDueSrsItemCount = (nowIso: string) => {
  const database = ensureSrsDatabase();
  const row = database
    .prepare(
      `
        SELECT COUNT(*) AS total
        FROM srs_item
        WHERE due <= @nowIso
      `,
    )
    .get({ nowIso }) as { total: number };

  return row.total;
};

const emitSrsDataChanged = () => {
  srsEventEmitter.emit('srs-data-changed');
};

const getNextScheduledSrsDueAt = (nowIso: string) => {
  const database = ensureSrsDatabase();
  const row = database
    .prepare(
      `
        SELECT due
        FROM srs_item
        WHERE due > @nowIso
        ORDER BY datetime(due) ASC, rowid ASC
        LIMIT 1
      `,
    )
    .get({ nowIso }) as { due: string } | undefined;

  return row?.due ?? null;
};

const buildSrsReviewQueue = (now: Date = new Date()): SrsReviewQueue => {
  const nowIso = now.toISOString();
  const currentRow = getNextDueSrsItemRow(nowIso);

  return {
    current: currentRow ? toSrsItem(currentRow) : null,
    dueCount: getDueSrsItemCount(nowIso),
    nextDueAt: getNextScheduledSrsDueAt(nowIso),
    ratingPreviews: currentRow
      ? previewFsrsReviews(toPersistedFsrsCardFields(currentRow), now)
      : [],
  };
};

const listSrsItemRows = (): SrsItemRow[] => {
  const database = ensureSrsDatabase();

  return database
    .prepare(
      `
        SELECT
          id,
          item,
          answer,
          category,
          source_entry_id,
          created_time,
          last_updated_time,
          due,
          stability,
          difficulty,
          elapsed_days,
          scheduled_days,
          learning_steps,
          reps,
          lapses,
          state,
          last_review
        FROM srs_item
        ORDER BY datetime(last_updated_time) DESC, rowid DESC
      `,
    )
    .all() as SrsItemRow[];
};

const getDuplicateSrsItemRow = (input: CreateSrsItemInput): SrsItemRow | null => {
  const database = ensureSrsDatabase();
  const category = normalizeSrsCategory(input.category);
  const item = input.item.trim();
  const sourceEntryId = normalizeSourceEntryId(input.sourceEntryId);

  if (category === 'kanji') {
    const row = database
      .prepare(
        `
          SELECT
            id,
            item,
            answer,
            category,
            source_entry_id,
            created_time,
            last_updated_time,
            due,
            stability,
            difficulty,
            elapsed_days,
            scheduled_days,
            learning_steps,
            reps,
            lapses,
            state,
            last_review
          FROM srs_item
          WHERE category = 'kanji' AND item = @item
          LIMIT 1
        `,
      )
      .get({ item }) as SrsItemRow | undefined;

    return row ?? null;
  }

  if (category === 'vocab') {
    const row = sourceEntryId !== null
      ? database
          .prepare(
            `
              SELECT
                id,
                item,
                answer,
                category,
                source_entry_id,
                created_time,
                last_updated_time,
                due,
                stability,
                difficulty,
                elapsed_days,
                scheduled_days,
                learning_steps,
                reps,
                lapses,
                state,
                last_review
              FROM srs_item
              WHERE category = 'vocab'
                AND (
                  source_entry_id = @sourceEntryId
                  OR (source_entry_id IS NULL AND item = @item)
                )
              ORDER BY CASE WHEN source_entry_id = @sourceEntryId THEN 0 ELSE 1 END
              LIMIT 1
            `,
          )
          .get({ sourceEntryId, item }) as SrsItemRow | undefined
      : database
          .prepare(
            `
              SELECT
                id,
                item,
                answer,
                category,
                source_entry_id,
                created_time,
                last_updated_time,
                due,
                stability,
                difficulty,
                elapsed_days,
                scheduled_days,
                learning_steps,
                reps,
                lapses,
                state,
                last_review
              FROM srs_item
              WHERE category = 'vocab'
                AND source_entry_id IS NULL
                AND item = @item
              LIMIT 1
            `,
          )
          .get({ item }) as SrsItemRow | undefined;

    return row ?? null;
  }

  if (category === 'sentence') {
    const row = database
      .prepare(
        `
          SELECT
            id,
            item,
            answer,
            category,
            source_entry_id,
            created_time,
            last_updated_time,
            due,
            stability,
            difficulty,
            elapsed_days,
            scheduled_days,
            learning_steps,
            reps,
            lapses,
            state,
            last_review
          FROM srs_item
          WHERE category = 'sentence' AND item = @item
          LIMIT 1
        `,
      )
      .get({ item }) as SrsItemRow | undefined;

    return row ?? null;
  }

  if (category === 'correction') {
    const row = database
      .prepare(
        `
          SELECT
            id,
            item,
            answer,
            category,
            source_entry_id,
            created_time,
            last_updated_time,
            due,
            stability,
            difficulty,
            elapsed_days,
            scheduled_days,
            learning_steps,
            reps,
            lapses,
            state,
            last_review
          FROM srs_item
          WHERE category = 'correction' AND item = @item
          LIMIT 1
        `,
      )
      .get({ item }) as SrsItemRow | undefined;

    return row ?? null;
  }

  return null;
};

const createDuplicateSrsItemError = (input: CreateSrsItemInput) => {
  const category = normalizeSrsCategory(input.category);

  if (category === 'kanji') {
    return new Error('This kanji is already in SRS.');
  }

  if (category === 'vocab') {
    return new Error('This vocab item is already in SRS.');
  }

  if (category === 'sentence') {
    return new Error('This sentence is already in SRS.');
  }

  if (category === 'correction') {
    return new Error('This correction card is already in SRS.');
  }

  return new Error('This SRS item already exists.');
};

const isUniqueConstraintError = (error: unknown) => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = 'code' in error ? error.code : null;
  const message = 'message' in error ? error.message : null;

  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    (typeof message === 'string' && message.includes('UNIQUE constraint failed'))
  );
};

const indentMultiline = (value: string) =>
  value
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');

const buildSrsExportMarkdown = (items: SrsItemRow[], exportedAt: string) => {
  const sections = items.map((item, index) => {
    const details = [
      `### ${index + 1}. ${item.item}`,
      `- Category: ${item.category}`,
      `- Source entry ID: ${item.source_entry_id ?? '—'}`,
      `- Created: ${item.created_time}`,
      `- Updated: ${item.last_updated_time}`,
      `- Due: ${item.due}`,
      `- State: ${fsrsStateLabel(item.state)}`,
      `- Reps: ${item.reps}`,
      `- Lapses: ${item.lapses}`,
      `- Stability: ${item.stability}`,
      `- Difficulty: ${item.difficulty}`,
      `- Scheduled days: ${item.scheduled_days}`,
      `- Learning steps: ${item.learning_steps}`,
      `- Last review: ${item.last_review ?? '—'}`,
      '',
      '#### Answer',
      '',
      indentMultiline(item.answer),
    ];

    return details.join('\n');
  });

  return [
    '# ToraChat SRS Export',
    '',
    `- Exported at: ${exportedAt}`,
    `- Total cards: ${items.length}`,
    '',
    ...sections,
    '',
  ].join('\n');
};

const ensureChatsDatabase = () => {
  if (!chatsDatabase) {
    throw new Error('Chats database is not initialized.');
  }

  return chatsDatabase;
};

const isChatMessageCorrectionDetail = (
  value: unknown,
): value is NonNullable<ChatMessage['correction']>['corrections'][number] => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as {
    originalText?: unknown;
    correctedText?: unknown;
    explanation?: unknown;
  };

  return (
    (candidate.originalText === null || candidate.originalText === undefined || typeof candidate.originalText === 'string') &&
    typeof candidate.correctedText === 'string' &&
    typeof candidate.explanation === 'string'
  );
};

const sanitizeChatMessageCorrection = (value: unknown): ChatMessage['correction'] => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<NonNullable<ChatMessage['correction']>>;

  if (
    typeof candidate.correctedText !== 'string' ||
    typeof candidate.translation !== 'string' ||
    typeof candidate.generatedAt !== 'string' ||
    !Array.isArray(candidate.corrections)
  ) {
    return null;
  }

  return {
    correctedText: candidate.correctedText,
    translation: candidate.translation,
    generatedAt: candidate.generatedAt,
    corrections: candidate.corrections
      .filter(isChatMessageCorrectionDetail)
      .map((correction) => ({
        originalText: typeof correction.originalText === 'string' ? correction.originalText : null,
        correctedText: correction.correctedText,
        explanation: correction.explanation,
      })),
  };
};

const isChatMessage = (value: unknown): value is ChatMessage => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ChatMessage>;

  return (
    (candidate.role === 'user' || candidate.role === 'assistant') &&
    typeof candidate.content === 'string' &&
    typeof candidate.createdAt === 'string' &&
    (candidate.id === undefined || typeof candidate.id === 'string')
  );
};

const parseChatMessages = (historyJson: string): ChatMessage[] => {
  try {
    const parsed = JSON.parse(historyJson) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isChatMessage).map((message, index) => ({
      id: message.id ?? `${message.role}:${message.createdAt}:${index}`,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      correction: sanitizeChatMessageCorrection(message.correction),
    }));
  } catch {
    return [];
  }
};

const toChatSession = (row: ChatSessionRow): ChatSession => ({
  id: row.id,
  title: row.title,
  messages: parseChatMessages(row.history_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const sanitizeChatMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages
    .filter(isChatMessage)
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      correction: sanitizeChatMessageCorrection(message.correction),
    }));

const getChatSessionRow = (chatId: string): ChatSessionRow | null => {
  const database = ensureChatsDatabase();
  const row = database
    .prepare(
      `
        SELECT id, title, history_json, created_at, updated_at
        FROM chat_session
        WHERE id = ?
      `,
    )
    .get(chatId) as ChatSessionRow | undefined;

  return row ?? null;
};

const getNextUntitledChatIndex = () => {
  const database = ensureChatsDatabase();
  const row = database
    .prepare(
      `
        SELECT COUNT(*) AS total
        FROM chat_session
      `,
    )
    .get() as { total: number };

  return row.total + 1;
};

const getKuromojiDictionaryDirectory = () =>
  path.resolve(path.dirname(require.resolve('@patdx/kuromoji')), '../dict');

const toArrayBuffer = (buffer: Buffer): ArrayBuffer => Uint8Array.from(buffer).buffer;

const resolveBundledDictionaryJsonPath = ({
  appPath,
  isPackaged,
  resourcesPath,
}: DatabaseInitOptions) =>
  isPackaged
    ? path.join(resourcesPath, 'jmdict', 'jmdict-eng.json')
    : path.join(appPath, 'assets', 'jmdict', 'jmdict-eng.json');

const unique = <T>(values: T[]) => [...new Set(values)];

const uniqueStrings = (values: Array<string | null | undefined>) =>
  unique(
    values
      .map((value) => value?.trim() ?? '')
      .filter((value): value is string => value.length > 0),
  );

const hasKanji = (value: string) => /[\u3400-\u9FFF々〆ヵヶ]/u.test(value);

const safeGetField = async (
  db: JmdictDb,
  key: 'dictDate' | 'version',
  fallbackValue: string,
) => {
  try {
    return (await getField(db, key)) ?? fallbackValue;
  } catch {
    return fallbackValue;
  }
};

const formatGloss = (text: string, type: string | null) =>
  type ? `[${type}] ${text}` : text;

const expandTag = (tag: string, tags: JmdictTagMap) => tags[tag] ?? tag;

const formatSense = (wordSense: JmdictWord['sense'][number], tags: JmdictTagMap) => {
  const englishGlosses = (wordSense.gloss ?? []).filter(
    (gloss) => !gloss.lang || gloss.lang === 'eng',
  );
  const glosses = (englishGlosses.length > 0 ? englishGlosses : wordSense.gloss ?? [])
    .map((gloss) => formatGloss(gloss.text, gloss.type))
    .filter(Boolean);

  if (glosses.length === 0) {
    return '';
  }

  const annotations = uniqueStrings([
    ...(wordSense.field ?? []).map((tag) => expandTag(tag, tags)),
    ...(wordSense.misc ?? []).map((tag) => expandTag(tag, tags)),
    ...(wordSense.dialect ?? []).map((tag) => expandTag(tag, tags)),
    ...(wordSense.info ?? []),
  ]);

  return annotations.length > 0
    ? `[${annotations.join('; ')}] ${glosses.join('; ')}`
    : glosses.join('; ');
};

const preferredHeadword = (word: JmdictWord) =>
  word.kanji.find((entry) => entry.common)?.text ||
  word.kanji[0]?.text ||
  word.kana.find((entry) => entry.common)?.text ||
  word.kana[0]?.text ||
  '';

const preferredReading = (word: JmdictWord) =>
  word.kana.find((entry) => entry.common)?.text || word.kana[0]?.text || null;

const commonnessRank = (word: JmdictWord) => {
  if (word.kanji.some((entry) => entry.common)) {
    return 0;
  }

  if (word.kana.some((entry) => entry.common)) {
    return 1;
  }

  return 2;
};

const getExpandedPartsOfSpeech = (word: JmdictWord, tags: JmdictTagMap) =>
  uniqueStrings(
    (word.sense ?? []).flatMap((sense) =>
      (sense.partOfSpeech ?? []).map((tag) => expandTag(tag, tags)),
    ),
  );

const getPartOfSpeechPenalty = (
  word: JmdictWord,
  tags: JmdictTagMap,
  queryPartOfSpeech: string | null | undefined,
) => {
  if (!queryPartOfSpeech) {
    return 0;
  }

  const patterns = KUROMOJI_PART_OF_SPEECH_HINTS[queryPartOfSpeech];

  if (!patterns || patterns.length === 0) {
    return 0;
  }

  const entryPartsOfSpeech = getExpandedPartsOfSpeech(word, tags);

  return entryPartsOfSpeech.some((part) => patterns.some((pattern) => pattern.test(part)))
    ? 0
    : 1;
};

const getMatchedFormPenalty = (word: JmdictWord, target: SearchTarget) => {
  if (target.kind === 'reading') {
    const readingMatch = word.kana.find((entry) => entry.text === target.value);

    if (readingMatch?.common) {
      return 0;
    }

    if (readingMatch) {
      return 1;
    }

    const textMatch = word.kanji.find((entry) => entry.text === target.value);

    if (textMatch?.common) {
      return 2;
    }

    return textMatch ? 3 : 4;
  }

  const textMatch = word.kanji.find((entry) => entry.text === target.value);

  if (textMatch?.common) {
    return 0;
  }

  if (textMatch) {
    return 1;
  }

  const readingMatch = word.kana.find((entry) => entry.text === target.value);

  if (readingMatch?.common) {
    return 2;
  }

  return readingMatch ? 3 : 4;
};

const getLengthPenalty = (word: JmdictWord, target: SearchTarget) => {
  const preferredForm = preferredHeadword(word) || preferredReading(word) || '';

  return Math.abs(preferredForm.length - target.value.length);
};

const compareWordMatches = (left: WordMatch, right: WordMatch) =>
  left.target.priority - right.target.priority ||
  left.exactness - right.exactness ||
  left.partOfSpeechPenalty - right.partOfSpeechPenalty ||
  left.matchedFormPenalty - right.matchedFormPenalty ||
  left.commonnessPenalty - right.commonnessPenalty ||
  left.lengthPenalty - right.lengthPenalty ||
  Number(left.word.id) - Number(right.word.id);

const toDictionaryEntry = (
  match: WordMatch,
  tags: JmdictTagMap,
): DictionaryEntry => ({
  entSeq: Number(match.word.id),
  headword: preferredHeadword(match.word),
  reading: preferredReading(match.word),
  meanings: (match.word.sense ?? [])
    .map((sense) => formatSense(sense, tags))
    .filter(Boolean),
  partsOfSpeech: getExpandedPartsOfSpeech(match.word, tags),
  notes: uniqueStrings(
    (match.word.sense ?? []).flatMap((sense) => [
      ...(sense.field ?? []).map((tag) => expandTag(tag, tags)),
      ...(sense.misc ?? []).map((tag) => expandTag(tag, tags)),
      ...(sense.dialect ?? []).map((tag) => expandTag(tag, tags)),
      ...(sense.info ?? []),
    ]),
  ),
  source: 'jmdict',
  matchedForm: match.target.value,
});

const buildSearchTargets = (query: DictionaryLookupQuery): SearchTarget[] => {
  const targets: SearchTarget[] = [];
  const seen = new Set<string>();

  const pushTarget = (
    value: string | null | undefined,
    kind: SearchTarget['kind'],
    priority: number,
  ) => {
    const normalizedValue = value?.trim();

    if (!normalizedValue) {
      return;
    }

    const key = `${kind}:${normalizedValue}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    targets.push({ value: normalizedValue, kind, priority });
  };

  pushTarget(query.surfaceForm, 'text', 0);
  if (query.surfaceForm && !hasKanji(query.surfaceForm)) {
    pushTarget(query.surfaceForm, 'reading', 0);
  }

  pushTarget(query.basicForm, 'text', 1);
  if (query.basicForm && !hasKanji(query.basicForm)) {
    pushTarget(query.basicForm, 'reading', 1);
  }

  pushTarget(query.reading, 'reading', 2);

  return targets;
};

const exactnessForTarget = (word: JmdictWord, target: SearchTarget) => {
  const kanjiExact = word.kanji.some((entry) => entry.text === target.value);
  const kanaExact = word.kana.some((entry) => entry.text === target.value);

  if (target.kind === 'reading') {
    if (kanaExact) {
      return 0;
    }

    return kanjiExact ? 1 : null;
  }

  if (kanjiExact) {
    return 0;
  }

  return kanaExact ? 1 : null;
};

const lookupBundledDictionaryEntries = async (
  query: DictionaryLookupQuery,
): Promise<DictionaryEntry[]> => {
  if (!jmdictRuntime) {
    return [];
  }

  const { db, tags } = jmdictRuntime;

  const searchTargets = buildSearchTargets(query);

  if (searchTargets.length === 0) {
    return [];
  }

  const resultSets = await Promise.all(
    searchTargets.map(async (target) => ({
      target,
      words:
        target.kind === 'reading'
          ? await readingBeginning(db, target.value, 24)
          : await kanjiBeginning(db, target.value, 24),
    })),
  );

  const bestMatches = new Map<string, WordMatch>();

  for (const resultSet of resultSets) {
    for (const word of resultSet.words) {
      const exactness = exactnessForTarget(word, resultSet.target);

      if (exactness === null) {
        continue;
      }

      const existingMatch = bestMatches.get(word.id);
      const nextMatch: WordMatch = {
        word,
        target: resultSet.target,
        exactness,
        partOfSpeechPenalty: getPartOfSpeechPenalty(word, tags, query.partOfSpeech),
        matchedFormPenalty: getMatchedFormPenalty(word, resultSet.target),
        commonnessPenalty: commonnessRank(word),
        lengthPenalty: getLengthPenalty(word, resultSet.target),
      };

      if (!existingMatch || compareWordMatches(nextMatch, existingMatch) < 0) {
        bestMatches.set(word.id, nextMatch);
      }
    }
  }

  return [...bestMatches.values()]
    .sort(compareWordMatches)
    .slice(0, 6)
    .map((match) => toDictionaryEntry(match, tags));
};

const startBundledDictionaryInitialization = (options: DatabaseInitOptions) => {
  if (jmdictInitializationStarted) {
    return;
  }

  jmdictInitializationStarted = true;

  const bundledDictionaryJsonPath = resolveBundledDictionaryJsonPath(options);

  if (!existsSync(bundledDictionaryJsonPath)) {
    dictionaryStatus = {
      state: 'missing',
      source: 'jmdict',
      version: null,
      dictDate: null,
      detail:
        'Bundled JMdict JSON was not found. Run `npm run dictionary:bundle` before packaging the app.',
    };
    return;
  }

  const cacheDirectory = path.join(
    options.userDataPath,
    'data',
    'jmdict-simplified-cache',
  );
  mkdirSync(cacheDirectory, { recursive: true });

  dictionaryStatus = {
    state: 'loading',
    source: 'jmdict',
    version: null,
    dictDate: null,
    detail:
      'Preparing the bundled JMdict cache with jmdict-simplified-node.',
  };

  void setup(cacheDirectory, bundledDictionaryJsonPath, true, true)
    .then(async ({ db, dictDate, version }) => {
      const tags = await getTags(db);
      const resolvedDictDate = await safeGetField(db, 'dictDate', dictDate);
      const resolvedVersion = await safeGetField(db, 'version', version);

      jmdictRuntime = {
        db,
        tags,
        version: resolvedVersion,
        dictDate: resolvedDictDate,
      };
      dictionaryStatus = {
        state: 'ready',
        source: 'jmdict',
        version: resolvedVersion,
        dictDate: resolvedDictDate,
        detail: 'Bundled JMdict is ready in the Electron main process.',
      };
    })
    .catch((error: unknown) => {
      dictionaryStatus = {
        state: 'error',
        source: 'jmdict',
        version: null,
        dictDate: null,
        detail:
          error instanceof Error
            ? `Bundled JMdict failed to initialize: ${error.message}`
            : 'Bundled JMdict failed to initialize.',
      };
    });
};

export const initializeDatabases = (options: DatabaseInitOptions) => {
  if (srsDatabase && chatsDatabase) {
    return;
  }

  const dataDirectory = path.join(options.userDataPath, 'data');
  mkdirSync(dataDirectory, { recursive: true });

  srsDatabase = createDatabase(path.join(dataDirectory, 'srs.sqlite'), 'srs');
  initializeSrsStorage(srsDatabase);

  chatsDatabase = createDatabase(path.join(dataDirectory, 'chats.sqlite'), 'chats');
  initializeChatsStorage(chatsDatabase);

  startBundledDictionaryInitialization(options);
};

export const listChatSessions = (): ChatSessionSummary[] => {
  const database = ensureChatsDatabase();
  const rows = database
    .prepare(
      `
        SELECT id, title, history_json, updated_at
        FROM chat_session
        ORDER BY datetime(updated_at) DESC, rowid DESC
      `,
    )
    .all() as ChatSessionSummaryRow[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    messageCount: parseChatMessages(row.history_json).length,
  }));
};

export const createChatSession = (): ChatSession => {
  const database = ensureChatsDatabase();
  const now = new Date().toISOString();
  const chatId = randomUUID();
  const title = `Untitled (${getNextUntitledChatIndex()})`;

  database
    .prepare(
      `
        INSERT INTO chat_session (id, title, history_json, created_at, updated_at)
        VALUES (@id, @title, @historyJson, @createdAt, @updatedAt)
      `,
    )
    .run({
      id: chatId,
      title,
      historyJson: '[]',
      createdAt: now,
      updatedAt: now,
    });

  const createdSession = getChatSessionRow(chatId);

  if (!createdSession) {
    throw new Error('Unable to create chat session.');
  }

  return toChatSession(createdSession);
};

export const deleteChatSession = (chatId: string): void => {
  const database = ensureChatsDatabase();
  const result = database
    .prepare(
      `
        DELETE FROM chat_session
        WHERE id = ?
      `,
    )
    .run(chatId);

  if (result.changes === 0) {
    throw new Error(`Chat session not found: ${chatId}`);
  }
};

export const getChatSession = (chatId: string): ChatSession | null => {
  const session = getChatSessionRow(chatId);

  return session ? toChatSession(session) : null;
};

export const saveChatSession = (input: SaveChatSessionInput): ChatSession => {
  const database = ensureChatsDatabase();
  const now = new Date().toISOString();
  const messages = sanitizeChatMessages(input.messages);

  const result = database
    .prepare(
      `
        UPDATE chat_session
        SET history_json = @historyJson,
            updated_at = @updatedAt
        WHERE id = @id
      `,
    )
    .run({
      id: input.id,
      historyJson: JSON.stringify(messages),
      updatedAt: now,
    });

  if (result.changes === 0) {
    throw new Error(`Chat session not found: ${input.id}`);
  }

  const updatedSession = getChatSessionRow(input.id);

  if (!updatedSession) {
    throw new Error(`Unable to read chat session after save: ${input.id}`);
  }

  return toChatSession(updatedSession);
};

export const getSrsStats = (): SrsStats => {
  const database = ensureSrsDatabase();
  const now = new Date().toISOString();

  const row = database
    .prepare(
      `
        SELECT
          COUNT(*) AS total_tracked,
          SUM(CASE WHEN state = @newState THEN 1 ELSE 0 END) AS new_cards,
          SUM(CASE WHEN state != @newState AND due <= @now THEN 1 ELSE 0 END) AS due_now
        FROM srs_item
      `,
    )
    .get({
      newState: FSRS_NEW_STATE,
      now,
    }) as SrsStatsRow;

  return {
    dueNow: row.due_now ?? 0,
    newCards: row.new_cards ?? 0,
    totalTracked: row.total_tracked,
  };
};

export const getSrsDueCount = () => getDueSrsItemCount(new Date().toISOString());

export const listDueSrsItems = (input?: ListDueSrsItemsInput): SrsItem[] =>
  listDueSrsItemRows({
    categories: input?.categories,
    nowIso: new Date().toISOString(),
  }).map(toSrsItem);

export const onSrsDataChanged = (listener: () => void) => {
  srsEventEmitter.on('srs-data-changed', listener);

  return () => {
    srsEventEmitter.off('srs-data-changed', listener);
  };
};

export const getSrsReviewQueue = (): SrsReviewQueue => buildSrsReviewQueue();

export const createSrsItem = (input: CreateSrsItemInput): SrsItem => {
  const database = ensureSrsDatabase();
  const item = input.item.trim();
  const answer = input.answer.trim();
  const category = normalizeSrsCategory(input.category);
  const sourceEntryId = category === 'vocab'
    ? normalizeSourceEntryId(input.sourceEntryId)
    : null;

  if (!item) {
    throw new Error('SRS item text is required.');
  }

  if (!answer) {
    throw new Error('SRS answer text is required.');
  }

  const now = new Date();
  const timestamp = now.toISOString();
  const initialCard = serializeFsrsCard(createInitialFsrsCard(now));
  const itemId = randomUUID();

  if (getDuplicateSrsItemRow({ item, answer, category, sourceEntryId })) {
    throw createDuplicateSrsItemError({ item, answer, category, sourceEntryId });
  }

  try {
    database
      .prepare(
        `
          INSERT INTO srs_item (
            id,
            item,
            answer,
            category,
            source_entry_id,
            created_time,
            last_updated_time,
            due,
            stability,
            difficulty,
            elapsed_days,
            scheduled_days,
            learning_steps,
            reps,
            lapses,
            state,
            last_review
          ) VALUES (
            @id,
            @item,
            @answer,
            @category,
            @sourceEntryId,
            @createdTime,
            @lastUpdatedTime,
            @due,
            @stability,
            @difficulty,
            @elapsedDays,
            @scheduledDays,
            @learningSteps,
            @reps,
            @lapses,
            @state,
            @lastReview
          )
        `,
      )
      .run({
        id: itemId,
        item,
        answer,
        category,
        sourceEntryId,
        createdTime: timestamp,
        lastUpdatedTime: timestamp,
        due: initialCard.due,
        stability: initialCard.stability,
        difficulty: initialCard.difficulty,
        elapsedDays: initialCard.elapsedDays,
        scheduledDays: initialCard.scheduledDays,
        learningSteps: initialCard.learningSteps,
        reps: initialCard.reps,
        lapses: initialCard.lapses,
        state: initialCard.state,
        lastReview: initialCard.lastReview,
      });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw createDuplicateSrsItemError({ item, answer, category, sourceEntryId });
    }

    throw error;
  }

  const createdItem = getSrsItemRow(itemId);

  if (!createdItem) {
    throw new Error('Unable to create SRS item.');
  }

  emitSrsDataChanged();

  return toSrsItem(createdItem);
};

export const updateSrsItem = (input: UpdateSrsItemInput): UpdateSrsItemResult => {
  const database = ensureSrsDatabase();
  const existingItem = getSrsItemRow(input.itemId);

  if (!existingItem) {
    throw new Error(`SRS item not found: ${input.itemId}`);
  }

  const item = input.item.trim();
  const answer = input.answer.trim();

  if (!item) {
    throw new Error('SRS item text is required.');
  }

  if (!answer) {
    throw new Error('SRS answer text is required.');
  }

  const duplicateRow = getDuplicateSrsItemRow({
    item,
    answer,
    category: existingItem.category,
    sourceEntryId: existingItem.source_entry_id,
  });

  if (duplicateRow && duplicateRow.id !== input.itemId) {
    throw createDuplicateSrsItemError({
      item,
      answer,
      category: existingItem.category,
      sourceEntryId: existingItem.source_entry_id,
    });
  }

  const now = new Date();
  const timestamp = now.toISOString();

  const result = database.transaction(() => {
    const updateResult = database
      .prepare(
        `
          UPDATE srs_item
          SET item = @item,
              answer = @answer,
              last_updated_time = @lastUpdatedTime
          WHERE id = @id
        `,
      )
      .run({
        id: input.itemId,
        item,
        answer,
        lastUpdatedTime: timestamp,
      });

    if (updateResult.changes === 0) {
      throw new Error(`Unable to update SRS item: ${input.itemId}`);
    }

    const updatedItem = getSrsItemRow(input.itemId);

    if (!updatedItem) {
      throw new Error(`Unable to read updated SRS item: ${input.itemId}`);
    }

    return {
      updatedItem: toSrsItem(updatedItem),
      queue: buildSrsReviewQueue(now),
    };
  })();

  emitSrsDataChanged();

  return result;
};

export const deleteSrsItem = (itemId: string): DeleteSrsItemResult => {
  const database = ensureSrsDatabase();
  const existingItem = getSrsItemRow(itemId);

  if (!existingItem) {
    throw new Error(`SRS item not found: ${itemId}`);
  }

  const now = new Date();

  const result = database.transaction(() => {
    const result = database
      .prepare(
        `
          DELETE FROM srs_item
          WHERE id = ?
        `,
      )
      .run(itemId);

    if (result.changes === 0) {
      throw new Error(`Unable to delete SRS item: ${itemId}`);
    }

    return {
      deletedItemId: itemId,
      queue: buildSrsReviewQueue(now),
    };
  })();

  emitSrsDataChanged();

  return result;
};

export const submitSrsReview = (
  input: SubmitSrsReviewInput,
): SubmitSrsReviewResult => {
  const database = ensureSrsDatabase();
  const rating = typeof input.rating === 'string' ? input.rating : '';

  if (!isSrsReviewRating(rating)) {
    throw new Error('A valid SRS review rating is required.');
  }

  const existingItem = getSrsItemRow(input.itemId);

  if (!existingItem) {
    throw new Error(`SRS item not found: ${input.itemId}`);
  }

  const now = new Date();
  const timestamp = now.toISOString();
  const reviewResult = applyFsrsReview(
    toPersistedFsrsCardFields(existingItem),
    rating,
    now,
  );
  const nextCard = serializeFsrsCard(reviewResult.card);

  const result = database.transaction(() => {
    const result = database
      .prepare(
        `
          UPDATE srs_item
          SET last_updated_time = @lastUpdatedTime,
              due = @due,
              stability = @stability,
              difficulty = @difficulty,
              elapsed_days = @elapsedDays,
              scheduled_days = @scheduledDays,
              learning_steps = @learningSteps,
              reps = @reps,
              lapses = @lapses,
              state = @state,
              last_review = @lastReview
          WHERE id = @id
        `,
      )
      .run({
        id: input.itemId,
        lastUpdatedTime: timestamp,
        due: nextCard.due,
        stability: nextCard.stability,
        difficulty: nextCard.difficulty,
        elapsedDays: nextCard.elapsedDays,
        scheduledDays: nextCard.scheduledDays,
        learningSteps: nextCard.learningSteps,
        reps: nextCard.reps,
        lapses: nextCard.lapses,
        state: nextCard.state,
        lastReview: nextCard.lastReview,
      });

    if (result.changes === 0) {
      throw new Error(`Unable to update SRS item: ${input.itemId}`);
    }

    const updatedItem = getSrsItemRow(input.itemId);

    if (!updatedItem) {
      throw new Error(`Unable to read updated SRS item: ${input.itemId}`);
    }

    return {
      reviewedItem: toSrsItem(updatedItem),
      queue: buildSrsReviewQueue(now),
    };
  })();

  emitSrsDataChanged();

  return result;
};

export const exportSrsItems = (outputDirectory: string): SrsExportResult => {
  const items = listSrsItemRows();
  const exportedAt = new Date().toISOString();
  const safeTimestamp = exportedAt.replace(/[:.]/g, '-');
  const filePath = path.join(outputDirectory, `torachat-srs-export-${safeTimestamp}.md`);

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(filePath, buildSrsExportMarkdown(items, exportedAt), 'utf8');

  return {
    filePath,
    itemCount: items.length,
    exportedAt,
  };
};

export const clearSrsData = (): SrsClearResult => {
  const database = ensureSrsDatabase();
  const clearedAt = new Date().toISOString();

  const result = database.transaction(() => {
    const deletedCount = database.prepare('DELETE FROM srs_item').run().changes;
    const deletedLegacyCount = hasTable(database, 'review_item')
      ? database.prepare('DELETE FROM review_item').run().changes
      : 0;

    return {
      deletedCount,
      deletedLegacyCount,
    };
  })();

  const clearResult = {
    deletedCount: result.deletedCount,
    deletedLegacyCount: result.deletedLegacyCount,
    clearedAt,
  };

  emitSrsDataChanged();

  return clearResult;
};

export const loadKuromojiDictionaryFile = (fileName: string) => {
  const normalizedFileName = path.basename(fileName);

  if (!/^[\w.-]+\.gz$/.test(normalizedFileName)) {
    throw new Error(`Unsupported Kuromoji dictionary file requested: ${fileName}`);
  }

  if (!kuromojiFileCache.has(normalizedFileName)) {
    const dictionaryPath = path.join(
      getKuromojiDictionaryDirectory(),
      normalizedFileName,
    );
    const decompressed = gunzipSync(readFileSync(dictionaryPath));

    kuromojiFileCache.set(normalizedFileName, toArrayBuffer(decompressed));
  }

  return kuromojiFileCache.get(normalizedFileName)!;
};

export const lookupDictionaryEntries = async (
  query: DictionaryLookupQuery,
): Promise<DictionaryEntry[]> => lookupBundledDictionaryEntries(query);

export const getDictionaryStatus = (): DictionaryStatus => dictionaryStatus;

export const closeDatabases = () => {
  srsDatabase?.close();
  chatsDatabase?.close();
  srsDatabase = null;
  chatsDatabase = null;
  kuromojiFileCache.clear();

  if (jmdictRuntime) {
    jmdictRuntime.db.close(() => undefined);
    jmdictRuntime = null;
  }
};
