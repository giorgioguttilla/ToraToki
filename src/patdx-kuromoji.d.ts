declare module '@patdx/kuromoji' {
  export interface LoaderConfig {
    loadArrayBuffer(fileName: string): Promise<ArrayBufferLike>;
  }

  export interface IpadicFeatures {
    word_id: number;
    word_type: string;
    word_position: number;
    surface_form: string;
    pos: string;
    pos_detail_1: string;
    pos_detail_2: string;
    pos_detail_3: string;
    conjugated_type: string;
    conjugated_form: string;
    basic_form: string;
    reading?: string;
    pronunciation?: string;
  }

  export interface Tokenizer {
    tokenize(text: string): IpadicFeatures[];
  }

  export class TokenizerBuilder {
    constructor(options: { loader: LoaderConfig });
    build(): Promise<Tokenizer>;
  }
}
