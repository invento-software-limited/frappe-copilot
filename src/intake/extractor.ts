import { LLMProvider } from '../providers/interface';
import { ContentChunk } from './splitter';
import { MergedUnderstanding } from '../types';

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
}

const READER_PROMPT = `You are a Frappe/ERPNext requirements analyst.
Extract ALL technical requirements, data models, UI components, and business logic from the given content.
Focus on:
1. DocTypes — What data entities? What fields?
2. UI Components — Forms, lists, dashboards, reports
3. Business Logic — Workflows, validations, calculations, permissions
4. Requirements — What the user wants to build
Be thorough and specific.`;

const MERGER_PROMPT = `You are a Frappe/ERPNext requirements synthesis specialist.
You receive partial analyses of a project specification. Merge them into ONE coherent, deduplicated, structured understanding.

Combine all findings into a unified specification covering:
1. Overall Summary — one paragraph describing the full project
2. Requirements — deduplicated list of all requirements
3. Frappe DocTypes — all DocTypes that need to be created
4. Frappe Modules — all modules involved
5. UI Components — all UI elements needed
6. Data Models — entities, fields, relationships
7. Unknowns — anything unclear

Remove duplicates, resolve contradictions, organize logically.`;

/**
 * Run multi-agent extraction:
 * 1. Split content into chunks
 * 2. Dispatch reader agents in parallel
 * 3. Merge all analyses into unified spec
 */
export async function extractContent(
  provider: LLMProvider,
  model: string,
  chunks: ContentChunk[],
  options: ExtractionOptions = {}
): Promise<{ merged: MergedUnderstanding; readerOutputs: { index: number; rawText: string }[] }> {
  const { onProgress } = options;
  const readerOutputs: { index: number; rawText: string }[] = [];

  if (chunks.length === 1) {
    onProgress?.({ phase: 'reading', message: 'Analyzing document...', chunkIndex: 0, totalChunks: 1 });
    const rawText = await callReader(provider, model, chunks[0], options);
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

  // Multi-chunk: sequential readers (more reliable than parallel)
  onProgress?.({ phase: 'reading', message: `Analyzing ${chunks.length} sections...`, totalChunks: chunks.length });
  const rawResults: (string | null)[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ phase: 'reading', message: `Reading section ${i + 1}/${chunks.length}`, chunkIndex: i, totalChunks: chunks.length });
    const text = await callReader(provider, model, chunks[i], options);
    if (text) {
      readerOutputs.push({ index: i, rawText: text });
      onProgress?.({ phase: 'reading', readerOutput: { index: i, rawText: text } });
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
  model: string,
  chunk: ContentChunk,
  options: ExtractionOptions
): Promise<string | null> {
  const messages = [
    { role: 'system' as const, content: options.readerSystemPrompt || READER_PROMPT },
    { role: 'user' as const, content: `Analyze this document section (part ${chunk.index + 1}):\n\n${chunk.text}\n\nProvide a structured analysis with:
- Summary
- Key points (bullet list)
- Frappe-relevant items (DocTypes, modules, UI, business logic)` },
  ];

  try {
    const response = await provider.chat(messages, { model, temperature: 0.3, maxTokens: 4096 });
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
  model: string,
  rawTexts: string[],
  labels: string[]
): Promise<MergedUnderstanding | null> {
  const body = rawTexts.map((t, i) => `## Section: ${labels[i]}\n${t}`).join('\n\n');

  const messages = [
    { role: 'system' as const, content: MERGER_PROMPT },
    { role: 'user' as const, content: `Merge these partial analyses into ONE unified specification:\n\n${body}\n\nOutput format:\n## Overall Summary\n...\n## Requirements\n- item 1\n- item 2\n## Frappe DocTypes\n- DocType1\n- DocType2\n## Frappe Modules\n- module1\n## UI Components\n- component1\n## Data Models\n- model1\n## Unknowns\n- question1` },
  ];

  try {
    const response = await provider.chat(messages, { model, temperature: 0.3, maxTokens: 4096 });
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

  const sectionNames = ['Overall Summary', 'Requirements', 'Frappe DocTypes', 'Frappe Modules', 'UI Components', 'Data Models', 'Unknowns'];

  // Identify section headers
  for (const line of lines) {
    const trimmed = line.trim();
    // Match headings: ## Title, **Title**, ### N. Title, Title:
    const match = trimmed.match(/^(?:#{1,3}\s+|\*\*|\d+[\.\)]\s*)?(Overall Summary|Requirements|Frappe DocTypes|Frappe Modules|UI Components|Data Models|Unknowns)\s*(?::\s*)?(?:\*\*)?$/i);
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
    unknowns: [],
  };
}
