/**
 * Content splitter — splits large extracted text into chunks
 * at natural breakpoints for parallel agent processing.
 *
 * Splitting strategy:
 * - PDF: at page breaks (---page--- markers) or paragraph boundaries
 * - HTML: at heading/topic boundaries
 * - Target chunk size: ~5000-6000 tokens (~20000-24000 chars)
 */

const MAX_CHUNK_CHARS = 12000; // ~5500 tokens
const MIN_CHUNK_CHARS = 4000;  // don't create tiny chunks

export interface ContentChunk {
  index: number;
  text: string;
  label: string;
  charCount: number;
  estimatedTokens: number;
}

/**
 * Split extracted text into chunks for parallel processing.
 * Returns a single chunk if content is small enough.
 */
export function splitContent(text: string, sourceName: string): ContentChunk[] {
  if (!text || text.trim().length === 0) {
    return [{
      index: 0,
      text: '(empty content)',
      label: `${sourceName} — full`,
      charCount: 0,
      estimatedTokens: 0,
    }];
  }

  // If content fits in one chunk, return it directly
  if (text.length <= MAX_CHUNK_CHARS) {
    return [{
      index: 0,
      text,
      label: `${sourceName} — full`,
      charCount: text.length,
      estimatedTokens: Math.ceil(text.length / 4),
    }];
  }

  // Content is too large — split it
  return splitIntoChunks(text, sourceName);
}

/**
 * Split text at natural boundaries (double newlines or headings).
 */
function splitIntoChunks(text: string, sourceName: string): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  let startIndex = 0;
  let chunkIndex = 0;

  while (startIndex < text.length) {
    // Find the end boundary for this chunk
    let endIndex = startIndex + MAX_CHUNK_CHARS;

    if (endIndex >= text.length) {
      // Last chunk — take the remainder
      const chunkText = text.slice(startIndex).trim();
      if (chunkText.length >= MIN_CHUNK_CHARS || chunks.length === 0) {
        chunks.push(makeChunk(chunkText, chunkIndex++, sourceName));
      } else if (chunks.length > 0) {
        // Too small to be its own chunk — merge with previous
        const last = chunks[chunks.length - 1];
        chunks[chunks.length - 1] = makeChunk(
          last.text + '\n\n' + chunkText,
          last.index,
          sourceName
        );
      }
      break;
    }

    // Try to find a natural break point (double newline) near the end
    const searchStart = Math.max(startIndex + MIN_CHUNK_CHARS, endIndex - 3000);
    const searchRegion = text.slice(searchStart, endIndex);
    let breakPos = searchRegion.lastIndexOf('\n\n');

    if (breakPos === -1) {
      // Fallback: try single newline
      breakPos = searchRegion.lastIndexOf('\n');
    }
    if (breakPos === -1) {
      // Fallback: try space
      breakPos = searchRegion.lastIndexOf('. ');
    }
    if (breakPos === -1) {
      // Last resort: hard cut at endIndex
      breakPos = searchRegion.length - 1;
    }

    const actualEnd = searchStart + breakPos + 1;
    const chunkText = text.slice(startIndex, actualEnd).trim();

    if (chunkText.length >= MIN_CHUNK_CHARS || chunks.length === 0) {
      chunks.push(makeChunk(chunkText, chunkIndex++, sourceName));
    } else if (chunks.length > 0) {
      // Merge with previous
      const last = chunks[chunks.length - 1];
      chunks[chunks.length - 1] = makeChunk(
        last.text + '\n\n' + chunkText,
        last.index,
        sourceName
      );
    }

    startIndex = actualEnd;
  }

  return chunks;
}

function makeChunk(text: string, index: number, sourceName: string): ContentChunk {
  return {
    index,
    text,
    label: `${sourceName} — part ${index + 1}`,
    charCount: text.length,
    estimatedTokens: Math.ceil(text.length / 4),
  };
}
