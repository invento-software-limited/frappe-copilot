import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { PNG } from 'pngjs';
import { IntakeFile, IntakeFileType, ImageAttachment } from '../types';

// ─── Embedded image extraction tuning ──────────────────────────────────────
// Diagrams/architecture drawings in a PDF are almost always embedded as
// raster XObjects (even vector-drawn diagrams exported from most tools end
// up rasterized on save-as-PDF), so pulling these out and handing them to a
// vision-capable model is enough to cover the common case without needing a
// full page-rasterization pipeline (which would require a native canvas
// dependency — a real packaging risk for a cross-platform VS Code extension).
const MIN_IMAGE_DIM = 80;          // below this on either side: icon/bullet/logo noise, skip
const MAX_IMAGES_PER_PAGE = 6;
const DEFAULT_MAX_IMAGES_PER_DOCUMENT = 24;
const MAX_IMAGE_DIM = 1568;        // downscale anything larger to bound payload size/cost

interface ExtractedImage {
  page: number;
  image: ImageAttachment;
}

/** Nearest-neighbor decimation — good enough for a document-understanding
 *  vision call (not a quality-critical render path), and needs no image
 *  library beyond the RGBA buffer we already have in hand. */
function downscale(data: Uint8Array | Uint8ClampedArray, width: number, height: number, maxDim: number): { data: Uint8Array; width: number; height: number } {
  if (width <= maxDim && height <= maxDim) {
    return { data: data instanceof Uint8Array ? data : new Uint8Array(data), width, height };
  }
  const scale = maxDim / Math.max(width, height);
  const newW = Math.max(1, Math.round(width * scale));
  const newH = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(newW * newH * 4);
  for (let y = 0; y < newH; y++) {
    const srcY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < newW; x++) {
      const srcX = Math.min(width - 1, Math.floor(x / scale));
      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = (y * newW + x) * 4;
      out[dstIdx] = data[srcIdx];
      out[dstIdx + 1] = data[srcIdx + 1];
      out[dstIdx + 2] = data[srcIdx + 2];
      out[dstIdx + 3] = data[srcIdx + 3];
    }
  }
  return { data: out, width: newW, height: newH };
}

/** Normalizes whatever pixel format pdfjs decoded an image XObject to
 *  (grayscale/RGB/RGBA — see pdfjs's ImageKind enum) into RGBA, which is what
 *  pngjs's encoder expects. Returns null for formats not worth the complexity
 *  here (1bpp stencil masks are overwhelmingly text/pattern fills, not
 *  diagrams). */
function toRgba(kind: number, data: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array | null {
  const pixelCount = width * height;
  // pdfjs ImageKind: GRAYSCALE_1BPP = 1, RGB_24BPP = 2, RGBA_32BPP = 3
  if (kind === 3) {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }
  if (kind === 2) {
    const out = new Uint8Array(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
      out[i * 4] = data[i * 3];
      out[i * 4 + 1] = data[i * 3 + 1];
      out[i * 4 + 2] = data[i * 3 + 2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  return null; // 1bpp mask or unrecognized kind — skip
}

/** Walks one page's operator list to pull out embedded raster images
 *  (paintImageXObject calls), re-encoding each as a PNG via pngjs (pure JS,
 *  no native/platform-specific binary — see the module comment above for
 *  why that constraint matters here). Requires `page.getOperatorList()` to
 *  have already resolved, which populates `page.objs` synchronously. */
function extractPageImages(pdfjsLib: any, page: any, opList: any, pageNum: number, seenHashes: Set<string>, maxPerPage: number): ExtractedImage[] {
  const results: ExtractedImage[] = [];
  const OPS = pdfjsLib.OPS;
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject]);

  for (let i = 0; i < opList.fnArray.length; i++) {
    if (results.length >= maxPerPage) break;
    if (!imageOps.has(opList.fnArray[i])) continue;

    const objId = opList.argsArray[i]?.[0];
    if (!objId || typeof objId !== 'string') continue;

    let obj: any;
    try {
      obj = page.objs.get(objId);
    } catch {
      continue; // not resolved (shouldn't happen once getOperatorList has settled) — skip rather than fail the whole page
    }
    if (!obj || !obj.data || !obj.width || !obj.height) continue;
    if (obj.width < MIN_IMAGE_DIM || obj.height < MIN_IMAGE_DIM) continue;

    const rgba = toRgba(obj.kind, obj.data, obj.width, obj.height);
    if (!rgba) continue;

    const hash = crypto.createHash('sha1').update(Buffer.from(rgba.buffer, rgba.byteOffset, Math.min(rgba.length, 4096))).digest('hex');
    if (seenHashes.has(hash)) continue; // repeated logo/header/footer across pages
    seenHashes.add(hash);

    const scaled = downscale(rgba, obj.width, obj.height, MAX_IMAGE_DIM);
    const png = new PNG({ width: scaled.width, height: scaled.height });
    png.data = Buffer.from(scaled.data);
    const pngBuffer = PNG.sync.write(png);

    results.push({
      page: pageNum,
      image: { mediaType: 'image/png', name: `page${pageNum}-${objId}.png`, data: pngBuffer.toString('base64') },
    });
  }
  return results;
}

/**
 * Read a PDF file and extract its text content, plus any embedded diagram/
 * screenshot images worth showing a vision-capable model (see module comment).
 * Uses pdfjs-dist v4 legacy build which runs in Node.js without a web worker
 * or DOMMatrix — handles Type3 fonts and complex PDFs.
 */
async function readPdf(filePath: string, opts: { extractImages: boolean; maxImages: number }): Promise<{ pageTexts: string[]; images: ExtractedImage[] }> {
  const importModule = new Function('specifier', 'return import(specifier)');
  const pdfjsLib: any = await importModule('pdfjs-dist/legacy/build/pdf.mjs');

  // Register legacy worker as file:// URL — needed by Node.js
  const workerPath = path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs');
  const workerUrl = 'file:///' + workerPath.replace(/\\/g, '/');
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

  const dataBuffer = fs.readFileSync(filePath);
  const data = new Uint8Array(dataBuffer);

  const doc = await pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;

  const numPages = doc.numPages;
  const pageTexts: string[] = [];
  const images: ExtractedImage[] = [];
  const seenHashes = new Set<string>();

  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const wantImages = opts.extractImages && images.length < opts.maxImages;
    const [textContent, opList] = await Promise.all([
      page.getTextContent(),
      wantImages ? page.getOperatorList() : Promise.resolve(null),
    ]);

    const text = textContent.items
      .map((item: any) => item.str || '')
      .join(' ');
    pageTexts.push(text);

    if (opList) {
      const pageImages = extractPageImages(pdfjsLib, page, opList, i, seenHashes, MAX_IMAGES_PER_PAGE);
      for (const img of pageImages) {
        if (images.length >= opts.maxImages) break;
        images.push(img);
      }
    }
  }

  return { pageTexts, images };
}

function readHtml(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let cleaned = raw.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  cleaned = cleaned.replace(/<\/?(?:br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n');
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  cleaned = cleaned.replace(/&nbsp;/g, ' ');
  cleaned = cleaned.replace(/&amp;/g, '&');
  cleaned = cleaned.replace(/&lt;/g, '<');
  cleaned = cleaned.replace(/&gt;/g, '>');
  cleaned = cleaned.replace(/&quot;/g, '"');
  cleaned = cleaned.replace(/&#39;/g, "'");
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.replace(/[ \t]+/g, ' ');
  return cleaned.trim();
}

export async function readIntakeFile(filePath: string): Promise<IntakeFile> {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  const stats = fs.statSync(filePath);

  let type: IntakeFileType;
  let content: string;
  let pageTexts: string[] | undefined;
  let images: { page: number; image: ImageAttachment }[] | undefined;

  if (ext === '.pdf') {
    type = 'pdf';
    const config = vscode.workspace.getConfiguration('frappe-copilot');
    const extractImages = config.get<boolean>('intake.extractImages', true);
    const maxImages = config.get<number>('intake.maxExtractedImages', DEFAULT_MAX_IMAGES_PER_DOCUMENT);
    const result = await readPdf(filePath, { extractImages, maxImages });
    pageTexts = result.pageTexts;
    images = result.images;
    content = pageTexts.join('\n\n---page break---\n\n');
  } else if (ext === '.html' || ext === '.htm') {
    type = 'html';
    content = readHtml(filePath);
  } else {
    throw new Error(`Unsupported file type: ${ext}. Only PDF and HTML files are supported.`);
  }

  return { name: fileName, type, size: stats.size, content, originalPath: filePath, pageTexts, images };
}
