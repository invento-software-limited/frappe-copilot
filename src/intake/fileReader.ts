import * as fs from 'fs';
import * as path from 'path';
import { IntakeFile, IntakeFileType } from '../types';

/**
 * Read a PDF file and extract its text content.
 * Uses pdfjs-dist v4 legacy build which runs in Node.js without
 * a web worker or DOMMatrix — handles Type3 fonts and complex PDFs.
 */
async function readPdf(filePath: string): Promise<string> {
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
  const pages: string[] = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item: any) => item.str || '')
      .join(' ');
    pages.push(text);
  }

  return pages.join('\n\n---page break---\n\n');
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

  if (ext === '.pdf') {
    type = 'pdf';
    content = await readPdf(filePath);
  } else if (ext === '.html' || ext === '.htm') {
    type = 'html';
    content = readHtml(filePath);
  } else {
    throw new Error(`Unsupported file type: ${ext}. Only PDF and HTML files are supported.`);
  }

  return { name: fileName, type, size: stats.size, content, originalPath: filePath };
}
