/**
 * Content splitter — splits large extracted text into chunks
 * at natural breakpoints for parallel agent processing.
 *
 * Splitting strategy:
 * - PDF: at page breaks (---page--- markers) or paragraph boundaries
 * - HTML: at heading/topic boundaries
 * - Target chunk size: ~5000-6000 tokens (~20000-24000 chars)
 */

export const MAX_CHUNK_CHARS = 12000; // ~5500 tokens
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

/** A chunk that also knows which source pages it spans (1-based, inclusive) —
 *  lets the caller attach only the images extracted from those pages to this
 *  chunk's reader call, instead of every image in the document. */
export interface PageAlignedChunk extends ContentChunk {
  pageStart: number;
  pageEnd: number;
}

/**
 * Split per-page text (as returned by fileReader's PDF extraction) into
 * chunks, greedily packing whole pages rather than cutting mid-page. Page
 * boundaries are a cleaner natural unit than the character-boundary search
 * splitContent() falls back to for page-less input (HTML), and — critically
 * for image support — they're what lets a chunk's images be looked up by
 * page range instead of re-scanning the whole document per chunk.
 *
 * A single page whose text alone exceeds MAX_CHUNK_CHARS becomes its own
 * oversized chunk rather than being split mid-page — a rare edge case
 * (a page that dense) not worth breaking the page-alignment guarantee for.
 */
export function splitPagesIntoChunks(pageTexts: string[], sourceName: string): PageAlignedChunk[] {
  if (!pageTexts || pageTexts.length === 0) {
    return [{
      index: 0,
      text: '(empty content)',
      label: `${sourceName} — full`,
      charCount: 0,
      estimatedTokens: 0,
      pageStart: 1,
      pageEnd: 1,
    }];
  }

  const chunks: PageAlignedChunk[] = [];
  let bufferText = '';
  let bufferStart = 1; // 1-based page number
  let chunkIndex = 0;

  const flush = (endPage: number) => {
    if (!bufferText.trim()) return;
    const text = bufferText.trim();
    chunks.push({
      ...makeChunk(text, chunkIndex++, sourceName),
      pageStart: bufferStart,
      pageEnd: endPage,
    });
    bufferText = '';
  };

  for (let i = 0; i < pageTexts.length; i++) {
    const pageNum = i + 1;
    const pageText = pageTexts[i] || '';

    if (bufferText.length === 0) {
      bufferStart = pageNum;
    }

    const wouldBe = bufferText ? bufferText.length + 2 + pageText.length : pageText.length;
    if (wouldBe > MAX_CHUNK_CHARS && bufferText.length >= MIN_CHUNK_CHARS) {
      // Current buffer is already a reasonable chunk — cut here, start fresh with this page.
      flush(pageNum - 1);
      bufferStart = pageNum;
      bufferText = pageText;
    } else {
      bufferText = bufferText ? bufferText + '\n\n' + pageText : pageText;
    }
  }
  flush(pageTexts.length);

  if (chunks.length === 0) {
    return [{
      index: 0,
      text: '(empty content)',
      label: `${sourceName} — full`,
      charCount: 0,
      estimatedTokens: 0,
      pageStart: 1,
      pageEnd: pageTexts.length,
    }];
  }

  return chunks;
}
