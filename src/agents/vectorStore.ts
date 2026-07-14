import * as fs from 'fs';
import * as path from 'path';
import { LLMProvider } from '../providers/interface';

interface TextChunk {
  id: string;
  source: string;
  text: string;
  vector?: number[];
}

interface VectorStoreData {
  version: string;
  chunks: TextChunk[];
}

export class VectorStore {
  private storePath: string;
  private docsDir: string;
  private templatesDir: string;
  private data: VectorStoreData = { version: '1.0', chunks: [] };
  private isFallbackMode = false;
  private initializedPromise: Promise<void>;

  constructor(
    private copilotPath: string,
    private extensionPath: string,
    private provider: LLMProvider
  ) {
    this.storePath = path.join(this.copilotPath, 'docs', 'vector_store.json');
    this.docsDir = path.join(this.extensionPath, 'assets', 'docs');
    this.templatesDir = path.join(this.extensionPath, 'assets', 'templates');
    this.initializedPromise = this.initialize();
  }

  /** Initialize store by loading cache or indexing local files. */
  private async initialize(): Promise<void> {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf-8');
        this.data = JSON.parse(raw) as VectorStoreData;
        console.log(`Loaded ${this.data.chunks.length} cached chunks from vector store.`);
      } else {
        await this.rebuildIndex();
      }
    } catch (err) {
      console.error('Failed to initialize VectorStore, falling back to keyword search:', err);
      this.isFallbackMode = true;
    }
  }

  /** Read assets/docs & assets/templates, split/load them, generate embeddings, and cache. */
  async rebuildIndex(): Promise<void> {
    try {
      console.log('Rebuilding vector index...');
      this.data.chunks = [];
      const tempChunks: Omit<TextChunk, 'id'>[] = [];

      // 1. Index documentation MD files
      if (fs.existsSync(this.docsDir)) {
        const files = fs.readdirSync(this.docsDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
          const filePath = path.join(this.docsDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const fileChunks = this.splitIntoChunks(content, 1000);
          
          for (const text of fileChunks) {
            tempChunks.push({
              source: `docs/${file}`,
              text: text.trim()
            });
          }
        }
      }

      // 2. Index custom boilerplate templates
      if (fs.existsSync(this.templatesDir)) {
        const files = fs.readdirSync(this.templatesDir).filter(f => f.endsWith('.py') || f.endsWith('.js'));
        for (const file of files) {
          const filePath = path.join(this.templatesDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          
          tempChunks.push({
            source: `templates/${file}`,
            text: content.trim()
          });
        }
      }

      // 3. Generate embeddings
      let idCounter = 1;
      for (const chunk of tempChunks) {
        let vector: number[] | undefined = undefined;

        if (!this.isFallbackMode && this.provider.getEmbeddings) {
          try {
            vector = await this.provider.getEmbeddings(chunk.text);
          } catch (e) {
            console.warn(`Embeddings failed for chunk ${idCounter}. Falling back to keyword search.`, e);
            this.isFallbackMode = true;
          }
        }

        this.data.chunks.push({
          id: `chunk-${idCounter++}`,
          source: chunk.source,
          text: chunk.text,
          vector
        });
      }

      // 4. Save cache file
      try {
        fs.writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), 'utf-8');
        console.log(`Index built successfully with ${this.data.chunks.length} chunks.`);
      } catch (err) {
        console.error('Failed to write vector store cache:', err);
      }
    } catch (err) {
      console.error('Fatal error during vector index rebuild:', err);
    }
  }

  /** Split markdown file contents by double newlines or max character blocks. */
  private splitIntoChunks(text: string, maxChars: number): string[] {
    const paragraphs = text.split(/\n\n+/);
    const chunks: string[] = [];
    let currentChunk = '';

    for (const para of paragraphs) {
      if ((currentChunk + para).length > maxChars) {
        if (currentChunk.trim()) {
          chunks.push(currentChunk);
        }
        currentChunk = para;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + para;
      }
    }
    if (currentChunk.trim()) {
      chunks.push(currentChunk);
    }
    return chunks;
  }

  /** Perform semantic cosine-similarity search, or keyword overlap ranking. */
  async search(query: string, limit: number = 3): Promise<TextChunk[]> {
    await this.initializedPromise;
    if (!query || this.data.chunks.length === 0) return [];

    // Rebuild index on-the-fly if cache was empty
    if (this.data.chunks.length === 0 && fs.existsSync(this.docsDir)) {
      await this.rebuildIndex();
    }

    if (this.isFallbackMode || !this.provider.getEmbeddings) {
      return this.keywordSearch(query, limit);
    }

    try {
      const queryVector = await this.provider.getEmbeddings(query);
      const scored = this.data.chunks
        .filter(c => c.vector !== undefined)
        .map(chunk => {
          const similarity = this.cosineSimilarity(queryVector, chunk.vector!);
          return { chunk, similarity };
        });

      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, limit).map(s => s.chunk);
    } catch (e) {
      console.warn('Embeddings search failed. Using keyword search fallback.', e);
      this.isFallbackMode = true;
      return this.keywordSearch(query, limit);
    }
  }

  /** Simple cosine similarity calculation. */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0.0;
    let normA = 0.0;
    let normB = 0.0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /** Keyword score fallback based on term frequencies. */
  private keywordSearch(query: string, limit: number): TextChunk[] {
    const queryTokens = query.toLowerCase().split(/\W+/).filter(Boolean);
    if (queryTokens.length === 0) return this.data.chunks.slice(0, limit);

    const scored = this.data.chunks.map(chunk => {
      const textLower = chunk.text.toLowerCase();
      let matches = 0;
      for (const token of queryTokens) {
        if (textLower.includes(token)) {
          matches++;
        }
      }
      const score = matches / queryTokens.length;
      return { chunk, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.filter(s => s.score > 0).slice(0, limit).map(s => s.chunk);
  }
}
