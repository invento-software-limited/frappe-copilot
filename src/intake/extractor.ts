import { LLMProvider } from '../providers/interface';
import { ContentChunk, PageAlignedChunk } from './splitter';
import { MergedUnderstanding, ImageAttachment } from '../types';

/** Progress callback data. */
export interface ExtractionProgress {
  phase: 'reading' | 'merging' | 'done' | 'error';
  message?: string;
  chunkIndex?: number;
  totalChunks?: number;
  /** Raw text of a reader's output — emitted when a reader completes. */
  readerOutput?: { index: number; rawText: string };
}

export interface ExtractionOptions {
  readerSystemPrompt?: string;
  onProgress?: (progress: ExtractionProgress) => void;
  signal?: AbortSignal;
  /** Embedded diagram/screenshot images extracted from the source document
   *  (see fileReader.ts), each tagged with the page it came from. Only the
   *  images whose page falls inside a given chunk's page range are attached
   *  to that chunk's reader call — see resolveChunkImages(). */
  images?: { page: number; image: ImageAttachment }[];
}

const READER_PROMPT = `You are a Frappe/ERPNext requirements analyst.
Extract ALL technical requirements, data models, UI components, and business logic from the given content.
Focus on:
1. DocTypes — What data entities? What fields?
2. UI Components — Forms, lists, dashboards, reports
3. Business Logic — Workflows, validations, calculations, permissions
4. Requirements — What the user wants to build
Be thorough and specific.

If one or more images are attached, they are diagrams/screenshots from this same section of the document — read them as carefully as the text (architecture diagrams, ER diagrams, wireframes, flowcharts) and fold what they show into your analysis; don't treat them as decorative.

End your analysis with a section:
## Entities So Far
A short bullet list of every DocType, module, and top-level requirement name you identified in THIS section only (short names, no descriptions) — this is carried forward to the next section's analyst so they can recognize continuations and cross-references instead of treating your section in isolation.`;

const MERGER_PROMPT = `You are a Frappe/ERPNext requirements synthesis specialist.
You receive partial analyses of a project specification, produced section-by-section. Merge them into ONE coherent, deduplicated, structured understanding.

Combine all findings into a unified specification covering:
1. Overall Summary — one paragraph describing the full project
2. Requirements — deduplicated list of all requirements
3. Frappe DocTypes — all DocTypes that need to be created
4. Frappe Modules — all modules involved
5. UI Components — all UI elements needed
6. Data Models — entities, fields, relationships
7. Cross-Section Relationships — THIS IS CRITICAL: actively hunt for connections that only become visible once every section is compared side by side — a DocType introduced in one section whose fields are extended or referenced in another, a workflow described in one section that a later section assumes already exists, contradictions between sections about the same entity, naming inconsistencies for what's clearly the same concept. Do not just deduplicate text blocks — reason about relationships spanning sections.
8. Unknowns — anything unclear

Remove duplicates, resolve contradictions (noting the resolution under Cross-Section Relationships when you do), organize logically.`;

/** Extracts the "## Entities So Far" bullet list a reader appended to its
 *  output (see READER_PROMPT), for threading forward as the next chunk's
 *  context. Returns an empty array if the section is missing or malformed
 *  — never throws, since this is a best-effort continuity aid, not a
 *  correctness requirement. */
function extractEntitiesSoFar(rawText: string): string[] {
  const match = rawText.match(/##\s*Entities So Far\s*\n([\s\S]*?)(?=\n##\s|\n?$)/i);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('-') || l.startsWith('*') || l.startsWith('•'))
    .map(l => l.replace(/^[-*•\s]+/, '').trim())
    .filter(Boolean);
}

const MAX_PRIOR_SUMMARY_CHARS = 1500;

/** Merges newly-seen entities into the running list carried forward between
 *  chunks, deduping case-insensitively and capping total length so the
 *  context block handed to later readers doesn't grow unbounded on a
 *  many-section document. */
function mergeEntities(existing: string[], newer: string[]): string[] {
  const seen = new Set(existing.map(e => e.toLowerCase()));
  const merged = [...existing];
  for (const e of newer) {
    if (!seen.has(e.toLowerCase())) {
      seen.add(e.toLowerCase());
      merged.push(e);
    }
  }
  // Trim from the front (oldest) if over budget — later chunks benefit most
  // from the most-recently-seen entities, which are also the ones most
  // likely to be referenced again soon.
  let total = merged.join(', ').length;
  while (total > MAX_PRIOR_SUMMARY_CHARS && merged.length > 1) {
    const removed = merged.shift();
    total -= (removed?.length || 0) + 2;
  }
  return merged;
}

/** Returns the images whose page falls inside this chunk's page range, or
 *  all images if the chunk isn't page-aligned (e.g. an HTML source without
 *  a page concept — there's no better way to scope them, so just pass
 *  everything and let the reader judge relevance). */
function resolveChunkImages(chunk: ContentChunk | PageAlignedChunk, images?: { page: number; image: ImageAttachment }[]): ImageAttachment[] {
  if (!images || images.length === 0) return [];
  if (!('pageStart' in chunk)) return images.map(i => i.image);
  const { pageStart, pageEnd } = chunk as PageAlignedChunk;
  return images.filter(i => i.page >= pageStart && i.page <= pageEnd).map(i => i.image);
}

/**
 * Run multi-agent extraction:
 * 1. Split content into chunks
 * 2. Dispatch reader agents sequentially, each carrying forward a running
 *    memory of entities seen in earlier chunks (see extractEntitiesSoFar/
 *    mergeEntities) — this is what lets a later section recognize it's
 *    extending/referencing something introduced earlier instead of treating
 *    every chunk as an island.
 * 3. Merge all analyses into one unified specification, explicitly reasoning
 *    about cross-section relationships rather than only deduping text.
 */
export async function extractContent(
  provider: LLMProvider,
  model: string | undefined,
  chunks: (ContentChunk | PageAlignedChunk)[],
  options: ExtractionOptions = {}
): Promise<{ merged: MergedUnderstanding; readerOutputs: { index: number; rawText: string }[] }> {
  const { onProgress } = options;
  const readerOutputs: { index: number; rawText: string }[] = [];

  if (chunks.length === 1) {
    onProgress?.({ phase: 'reading', message: 'Analyzing document...', chunkIndex: 0, totalChunks: 1 });
    const images = resolveChunkImages(chunks[0], options.images);
    const rawText = await callReader(provider, model, chunks[0], '', images, options);
    if (!rawText) {
      return { merged: emptyMerged('Reader agent failed.'), readerOutputs: [] };
    }
    readerOutputs.push({ index: 0, rawText });
    onProgress?.({ phase: 'reading', readerOutput: { index: 0, rawText } });

    onProgress?.({ phase: 'merging', message: 'Finalizing...' });
    const merged = await callMerger(provider, model, [rawText], chunks.map(c => c.label));
    onProgress?.({ phase: 'done', message: 'Complete!' });
    return { merged: merged || emptyMerged('Merger agent failed.'), readerOutputs };
  }

  // Multi-chunk: sequential readers (more reliable than parallel, and lets
  // each chunk carry forward the running entity memory from the ones before it).
  onProgress?.({ phase: 'reading', message: `Analyzing ${chunks.length} sections...`, totalChunks: chunks.length });
  const rawResults: (string | null)[] = [];
  let priorEntities: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ phase: 'reading', message: `Reading section ${i + 1}/${chunks.length}`, chunkIndex: i, totalChunks: chunks.length });
    const priorSummary = priorEntities.length > 0
      ? `Entities already identified in earlier sections of this same document (note continuations/references to these rather than re-describing them from scratch): ${priorEntities.join(', ')}`
      : '';
    const images = resolveChunkImages(chunks[i], options.images);
    const text = await callReader(provider, model, chunks[i], priorSummary, images, options);
    if (text) {
      readerOutputs.push({ index: i, rawText: text });
      onProgress?.({ phase: 'reading', readerOutput: { index: i, rawText: text } });
      priorEntities = mergeEntities(priorEntities, extractEntitiesSoFar(text));
    }
    rawResults.push(text);
  }

  const valid = rawResults.filter((r): r is string => r !== null);
  if (valid.length === 0) {
    return { merged: emptyMerged('All reader agents failed.'), readerOutputs: [] };
  }

  onProgress?.({ phase: 'merging', message: `Merging ${valid.length} analyses...` });
  const merged = await callMerger(provider, model, valid, chunks.map(c => c.label));
  onProgress?.({ phase: 'done', message: 'Complete!' });
  return { merged: merged || emptyMerged('Merger agent failed.'), readerOutputs };
}

/** Call a reader agent and return raw text. */
async function callReader(
  provider: LLMProvider,
  model: string | undefined,
  chunk: ContentChunk,
  priorSummary: string,
  images: ImageAttachment[],
  options: ExtractionOptions
): Promise<string | null> {
  const priorBlock = priorSummary ? `\n\n### Context carried from earlier sections\n${priorSummary}` : '';
  const imageNote = images.length > 0 ? `\n\n${images.length} diagram/screenshot image(s) from this section are attached — read them alongside the text.` : '';

  const messages = [
    { role: 'system' as const, content: options.readerSystemPrompt || READER_PROMPT },
    {
      role: 'user' as const,
      content: `Analyze this document section (part ${chunk.index + 1}):\n\n${chunk.text}\n\nProvide a structured analysis with:
- Summary
- Key points (bullet list)
- Frappe-relevant items (DocTypes, modules, UI, business logic)${priorBlock}${imageNote}`,
      ...(images.length > 0 ? { images } : {}),
    },
  ];

  try {
    const response = await provider.chat(messages, { ...(model ? { model } : {}), temperature: 0.3, maxTokens: 4096 });
    return response.content || null;
  } catch (err: any) {
    console.error(`Reader ${chunk.index} failed:`, err.message || err);
    options.onProgress?.({ phase: 'reading', message: `Section ${chunk.index + 1} failed: ${(err.message || String(err)).slice(0, 100)}`, chunkIndex: chunk.index });
    return null;
  }
}

/** Call the merger agent. Returns parsed MergedUnderstanding. */
async function callMerger(
  provider: LLMProvider,
  model: string | undefined,
  rawTexts: string[],
  labels: string[]
): Promise<MergedUnderstanding | null> {
  const body = rawTexts.map((t, i) => `## Section: ${labels[i]}\n${t}`).join('\n\n');

  const messages = [
    { role: 'system' as const, content: MERGER_PROMPT },
    { role: 'user' as const, content: `Merge these partial analyses into ONE unified specification:\n\n${body}\n\nOutput format:\n## Overall Summary\n...\n## Requirements\n- item 1\n- item 2\n## Frappe DocTypes\n- DocType1\n- DocType2\n## Frappe Modules\n- module1\n## UI Components\n- component1\n## Data Models\n- model1\n## Cross-Section Relationships\n- relationship1\n## Unknowns\n- question1` },
  ];

  try {
    const response = await provider.chat(messages, { ...(model ? { model } : {}), temperature: 0.3, maxTokens: 4096 });
    return parseMerged(response.content);
  } catch (err) {
    console.error('Merger failed:', err);
    return null;
  }
}

/**
 * Parse the merger's response into MergedUnderstanding.
 * Handles multiple heading formats:
 *   ## Overall Summary
 *   **Overall Summary**
 *   ### 1. Overall Summary
 *   Overall Summary:
 */
function parseMerged(text: string): MergedUnderstanding {
  const lines = text.split('\n');

  const sections: Record<string, string[]> = {};
  let currentSection = '_intro';

  const sectionNames = ['Overall Summary', 'Requirements', 'Frappe DocTypes', 'Frappe Modules', 'UI Components', 'Data Models', 'Cross-Section Relationships', 'Unknowns'];

  // Identify section headers
  for (const line of lines) {
    const trimmed = line.trim();
    // Match headings: ## Title, **Title**, ### N. Title, Title:
    const match = trimmed.match(/^(?:#{1,3}\s+|\*\*|\d+[\.\)]\s*)?(Overall Summary|Requirements|Frappe DocTypes|Frappe Modules|UI Components|Data Models|Cross-Section Relationships|Unknowns)\s*(?::\s*)?(?:\*\*)?$/i);
    if (match) {
      currentSection = match[1];
      // Normalize to the canonical name
      const canon = sectionNames.find(n => n.toLowerCase() === currentSection.toLowerCase());
      if (canon) currentSection = canon;
      continue;
    }
    if (!sections[currentSection]) sections[currentSection] = [];
    sections[currentSection].push(trimmed);
  }

  const extractList = (arr: string[]): string[] => {
    if (!arr || arr.length === 0) return [];
    const items = arr.filter(l => l.startsWith('-') || l.startsWith('*') || l.startsWith('•') || /^\d+[\.\)]/.test(l));
    if (items.length === 0) {
      // No list items — treat the whole block as a paragraph
      return arr.filter(l => l.length > 0);
    }
    return items.map(i => i.replace(/^[-*\d\.\)\s]+/, '').trim()).filter(Boolean);
  };

  const getSection = (name: string): string[] => sections[name] || [];

  return {
    overallSummary: getSection('Overall Summary').join(' ') || sections['_intro']?.filter(l => l.length > 0).join(' ') || text.slice(0, 500),
    requirements: extractList(getSection('Requirements')),
    frappeDocTypes: extractList(getSection('Frappe DocTypes')),
    frappeModules: extractList(getSection('Frappe Modules')),
    uiComponents: extractList(getSection('UI Components')),
    dataModels: extractList(getSection('Data Models')),
    crossReferences: extractList(getSection('Cross-Section Relationships')),
    unknowns: extractList(getSection('Unknowns')),
  };
}

function emptyMerged(reason: string): MergedUnderstanding {
  return {
    overallSummary: reason,
    requirements: [],
    frappeDocTypes: [],
    frappeModules: [],
    uiComponents: [],
    dataModels: [],
    crossReferences: [],
    unknowns: [],
  };
}

/** Renders a MergedUnderstanding back into a markdown prompt — this becomes
 *  the orchestrator's user message once a large document has gone through
 *  the chunk/reader/merge pipeline, replacing the flat truncated-text prompt
 *  that used to be sent for any document over the single-chunk size. */
export function renderMergedUnderstandingAsMarkdown(merged: MergedUnderstanding, sourceName: string): string {
  const section = (title: string, items: string[]) =>
    items.length > 0 ? `## ${title}\n${items.map(i => `- ${i}`).join('\n')}\n\n` : '';

  return `# Document Analysis: ${sourceName}\n\n` +
    `## Overall Summary\n${merged.overallSummary}\n\n` +
    section('Requirements', merged.requirements) +
    section('Frappe DocTypes', merged.frappeDocTypes) +
    section('Frappe Modules', merged.frappeModules) +
    section('UI Components', merged.uiComponents) +
    section('Data Models', merged.dataModels) +
    section('Cross-Section Relationships', merged.crossReferences) +
    section('Unknowns / Open Questions', merged.unknowns);
}
