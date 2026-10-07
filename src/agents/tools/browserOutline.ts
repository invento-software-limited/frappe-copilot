import type { Frame, Page } from 'puppeteer-core';
import { SNAPSHOT_SCRIPT } from './browserSnapshot';

/** Room left for a frame's outline before frames are skipped altogether. */
const MIN_FRAME_CHARS = 200;

/** The page's outline across all of its frames. Each frame is outlined in
 *  its own context, so cross-origin iframes (payment widgets, embedded
 *  reports) are readable too; refs keep counting up so they stay unique. */
export async function outlinePage(page: Page, maxChars: number): Promise<string> {
  const parts: string[] = [];
  let used = 0;
  let nextRef = 1;
  for (const frame of page.frames()) {
    if (frame.detached) continue;
    const budget = maxChars - used;
    if (budget < MIN_FRAME_CHARS) {
      parts.push('… (more frames not shown)');
      break;
    }
    let result: { text: string; nextRef: number };
    try {
      result = await frame.evaluate(`(${SNAPSHOT_SCRIPT})(${budget}, ${nextRef})`) as { text: string; nextRef: number };
    } catch {
      continue; // a frame that navigated away or blocks scripts
    }
    nextRef = result.nextRef;
    const isMain = frame === page.mainFrame();
    if (!isMain && !result.text.trim()) continue;
    const text = isMain ? result.text : `--- frame: ${frame.url()} ---\n${result.text}`;
    parts.push(text);
    used += text.length;
  }
  return parts.join('\n\n');
}

/** The frame holding element [ref] from the latest outline, or null. */
export async function frameWithRef(page: Page, ref: number): Promise<Frame | null> {
  const selector = refSelector(ref);
  for (const frame of page.frames()) {
    try {
      if (!frame.detached && await frame.$(selector)) return frame;
    } catch { /* detached mid-search */ }
  }
  return null;
}

export function refSelector(ref: number): string {
  return `[data-fc-ref="${ref}"]`;
}
