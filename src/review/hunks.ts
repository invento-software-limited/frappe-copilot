import { diffArrays } from 'diff';

/** One contiguous change between the reviewed baseline and the file now.
 *  Indexes are 0-based line positions; `baseLines`/`currentLines` keep their
 *  line endings so applying a hunk reproduces the text exactly. */
export interface Hunk {
  baseStart: number;
  baseLines: string[];
  currentStart: number;
  currentLines: string[];
}

/** Splits text into lines that keep their terminators ("a\n", "b"). */
export function splitLines(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

/** The changes from `base` to `current`, adjacent removals and additions
 *  merged into one hunk the way a diff view shows them. */
export function computeHunks(base: string, current: string): Hunk[] {
  const hunks: Hunk[] = [];
  let baseLine = 0;
  let currentLine = 0;
  let open: Hunk | null = null;
  for (const part of diffArrays(splitLines(base), splitLines(current))) {
    if (!part.added && !part.removed) {
      open = null;
      baseLine += part.value.length;
      currentLine += part.value.length;
      continue;
    }
    if (!open) {
      open = { baseStart: baseLine, baseLines: [], currentStart: currentLine, currentLines: [] };
      hunks.push(open);
    }
    if (part.removed) {
      open.baseLines.push(...part.value);
      baseLine += part.value.length;
    } else {
      open.currentLines.push(...part.value);
      currentLine += part.value.length;
    }
  }
  return hunks;
}

/** The current text with one hunk put back to how the baseline had it. */
export function rejectHunk(current: string, hunk: Hunk): string {
  const lines = splitLines(current);
  lines.splice(hunk.currentStart, hunk.currentLines.length, ...hunk.baseLines);
  return lines.join('');
}

/** The baseline with one hunk taken from the current text — the hunk stops
 *  being a pending change. */
export function acceptHunk(base: string, hunk: Hunk): string {
  const lines = splitLines(base);
  lines.splice(hunk.baseStart, hunk.baseLines.length, ...hunk.currentLines);
  return lines.join('');
}

export interface ChangeStats {
  added: number;
  removed: number;
}

export function changeStats(hunks: Hunk[]): ChangeStats {
  return hunks.reduce((s, h) => ({ added: s.added + h.currentLines.length, removed: s.removed + h.baseLines.length }), { added: 0, removed: 0 });
}
