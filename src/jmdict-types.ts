export type JmdictTagMap = Record<string, string>;

export interface JmdictKanji {
  common: boolean;
  text: string;
  tags: string[];
}

export interface JmdictKana {
  common: boolean;
  text: string;
  tags: string[];
  appliesToKanji: string[];
}

export interface JmdictGloss {
  lang: string;
  text: string;
  type: string | null;
}

export interface JmdictSense {
  partOfSpeech: string[];
  appliesToKanji: string[];
  appliesToKana: string[];
  related: Array<[string, string, number] | [string, string] | [string, number] | [string]>;
  antonym: Array<[string, string, number] | [string, string] | [string, number] | [string]>;
  field: string[];
  dialect: string[];
  misc: string[];
  info: string[];
  languageSource: Array<{
    lang: string;
    full: boolean;
    wasei: boolean;
    text?: string;
  }>;
  gloss: JmdictGloss[];
}

export interface JmdictWord {
  id: string;
  kanji: JmdictKanji[];
  kana: JmdictKana[];
  sense: JmdictSense[];
}

export interface JmdictDb {
  get(key: string, options: { asBuffer: false }): Promise<string>;
  close(callback: (error?: Error | null) => void): void;
}

export interface JmdictModule {
  getField(
    db: JmdictDb,
    key: 'dictDate' | 'version' | 'dictRevisions' | 'tags',
  ): Promise<string>;
  getTags(db: JmdictDb): Promise<JmdictTagMap>;
  kanjiBeginning(db: JmdictDb, prefix: string, limit?: number): Promise<JmdictWord[]>;
  readingBeginning(db: JmdictDb, prefix: string, limit?: number): Promise<JmdictWord[]>;
  setup(
    dbpath: string,
    filename?: string,
    verbose?: boolean,
    omitPartial?: boolean,
  ): Promise<{
    db: JmdictDb;
    dictDate: string;
    version: string;
  }>;
}
