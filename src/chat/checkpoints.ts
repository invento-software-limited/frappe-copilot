import * as fs from 'fs';
import * as path from 'path';
import { diffLines, Change } from 'diff';
import { CheckpointEntry, Message } from '../types';

/** Same 1MB guardrail as ToolExecutor.readFile, so a huge file is never read,
 *  diffed or held in memory on the extension host thread. */
const MAX_DIFF_READ_BYTES = 1 * 1024 * 1024;

/** A file's text, or null when it's missing or too big to diff. */
export function readFileCapped(absPath: string): string | null {
  try {
    if (fs.statSync(absPath).size > MAX_DIFF_READ_BYTES) return null;
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/** The before-image of a file a tool is about to write — taken even if the
 *  write later fails, so revert always has something to restore. */
export function captureBeforeImage(root: string, relPath: string): CheckpointEntry {
  const absPath = path.resolve(root, relPath);
  const existedBefore = fs.existsSync(absPath);
  return {
    path: relPath,
    existedBefore,
    originalContent: existedBefore ? (readFileCapped(absPath) ?? undefined) : undefined,
  };
}

/** Restores each entry's before-image, or deletes the file if a run created it. */
export function restoreCheckpointEntries(root: string, entries: CheckpointEntry[]): void {
  for (const e of entries) {
    const abs = path.resolve(root, e.path);
    if (e.existedBefore) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, e.originalContent ?? '', 'utf-8');
    } else if (fs.existsSync(abs)) {
      fs.rmSync(abs);
    }
  }
}

/** Every checkpoint entry from every run a prompt spawned, keeping only the
 *  *earliest* before-image per path (runs are read in order), so the result
 *  reverts each file to how it was before the whole prompt started. */
export function mergePromptCheckpoint(
  messages: Message[],
  readCheckpoint: (runId: string) => CheckpointEntry[],
  promptId: string
): CheckpointEntry[] | null {
  const runIds = messages
    .filter(m => m.promptId === promptId && m.hasCheckpoint && m.runId)
    .map(m => m.runId!);
  if (runIds.length === 0) return null;

  const merged = new Map<string, CheckpointEntry>();
  for (const runId of runIds) {
    for (const entry of readCheckpoint(runId)) {
      if (!merged.has(entry.path)) merged.set(entry.path, entry);
    }
  }
  return [...merged.values()];
}

export interface RevertPreviewFile {
  path: string;
  willDelete: boolean;
  diffHunks: Change[] | null;
}

/** What reverting would change on disk now, file by file. */
export function buildRevertPreview(root: string, entries: CheckpointEntry[]): RevertPreviewFile[] {
  return entries.map(e => {
    if (!e.existedBefore) return { path: e.path, willDelete: true, diffHunks: null };
    const current = readFileCapped(path.resolve(root, e.path)) ?? '';
    return { path: e.path, willDelete: false, diffHunks: diffLines(current, e.originalContent ?? '') };
  });
}
