export interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;

  initialize(): Promise<void>;
  embed(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  dispose(): Promise<void>;
}
