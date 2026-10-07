import * as fs from 'fs';
import * as path from 'path';
import { ImageAttachment, Message } from '../types';
import { LLMProvider } from '../providers/interface';
import { readIntakeFile } from '../intake/fileReader';
import { splitContent, splitPagesIntoChunks, MAX_CHUNK_CHARS } from '../intake/splitter';
import { extractContent, renderMergedUnderstandingAsMarkdown } from '../intake/extractor';
import { ChatUi } from './chatUi';
import { imageMediaType, MAX_IMAGE_BYTES } from '../agents/tools/images';

/** The prompt a file attachment turns into. */
export interface PreparedAttachment {
  message: string;
  images?: ImageAttachment[];
}

/** Saves an uploaded file and turns it into a prompt: images go to the model
 *  as vision attachments; documents are text-extracted, and large ones are
 *  read section by section and merged. Returns null after reporting an error. */
export async function prepareAttachment(
  upload: { text?: string; fileName: string; data: string },
  uploadsDir: string,
  provider: LLMProvider,
  model: string | undefined,
  ui: ChatUi
): Promise<PreparedAttachment | null> {
  const { text: userPrompt, fileName, data } = upload;
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filePath = path.join(uploadsDir, Date.now() + '-' + fileName);
  fs.writeFileSync(filePath, Buffer.from(data, 'base64'));

  // The file stays on disk and only its path is stored (see ImageAttachment),
  // so messages.jsonl stays small.
  const mediaType = imageMediaType(fileName);
  if (mediaType) {
    const sizeBytes = Buffer.byteLength(data, 'base64');
    if (sizeBytes > MAX_IMAGE_BYTES) {
      ui.chat('error',
        `Image '${fileName}' is ${(sizeBytes / 1024 / 1024).toFixed(1)}MB — the limit is ` +
        `${MAX_IMAGE_BYTES / 1024 / 1024}MB. Resize or screenshot a smaller region and try again.`);
      return null;
    }
    return {
      message: userPrompt || 'Look at the attached image and help me with it.',
      images: [{ mediaType, name: fileName, path: filePath }],
    };
  }
  return readDocument(filePath, fileName, userPrompt, provider, model, ui);
}

async function readDocument(
  filePath: string, fileName: string, userPrompt: string | undefined,
  provider: LLMProvider, model: string | undefined, ui: ChatUi
): Promise<PreparedAttachment | null> {
  ui.chat('system', '📄 Extracting text from ' + fileName + '...');
  let intake: Awaited<ReturnType<typeof readIntakeFile>>;
  try {
    intake = await readIntakeFile(filePath);
    ui.chat('system', '📖 ' + intake.content.length.toLocaleString() + ' characters extracted' +
      (intake.images?.length ? `, ${intake.images.length} diagram/image(s) found` : ''));
  } catch (e: any) {
    ui.chat('error', 'Failed to read file: ' + e.message);
    return null;
  }
  const task = userPrompt ? `\n\n**Task:** ${userPrompt}` : '';

  // Fits in one model call: send as-is, keeping any extracted diagrams.
  if (intake.content.length <= MAX_CHUNK_CHARS) {
    return {
      message: '**File: ' + fileName + '**\n```\n' + intake.content + '\n```' + task,
      images: intake.images?.map(i => i.image),
    };
  }

  // Too big for one call: each section's reader sees what earlier sections
  // found, and the merger reasons about links that span sections.
  const chunks = intake.pageTexts
    ? splitPagesIntoChunks(intake.pageTexts, fileName)
    : splitContent(intake.content, fileName);
  ui.chat('system', `📚 Document is large (${intake.content.length.toLocaleString()} chars) — analyzing in ${chunks.length} section(s)...`);
  let lastProgress = '';
  const { merged } = await extractContent(provider, model, chunks, {
    images: intake.images,
    onProgress: (p) => {
      if (p.message && p.message !== lastProgress) {
        lastProgress = p.message;
        ui.chat('system', `${p.phase === 'merging' ? '🧩' : '🔎'} ${p.message}`);
      }
    },
  });
  return { message: renderMergedUnderstandingAsMarkdown(merged, fileName) + task };
}

/** Loads each attached image's bytes for the provider-bound copy of the
 *  history (only paths are persisted). A deleted file is dropped with a note
 *  rather than failing the whole run over a stale upload. */
export function hydrateImages(messages: Message[]): Message[] {
  return messages.map(m => {
    if (!m.images?.length) return m;
    const missing: string[] = [];
    const images: ImageAttachment[] = [];
    for (const img of m.images) {
      if (img.data) { images.push(img); continue; }
      try {
        images.push({ ...img, data: fs.readFileSync(img.path!).toString('base64') });
      } catch {
        missing.push(img.name || path.basename(img.path || 'image'));
      }
    }
    const note = missing.length
      ? `\n\n_(attached image${missing.length > 1 ? 's' : ''} no longer available: ${missing.join(', ')})_`
      : '';
    return { ...m, images, content: m.content + note };
  });
}
