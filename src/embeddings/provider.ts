export interface EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;

  initialize(): Promise<void>;
  embed(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  dispose(): Promise<void>;
}
