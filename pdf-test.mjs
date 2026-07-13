import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';

const file = 'C:\Users\Md Omar Faruk\Downloads\Invento_Proposal_Shangu_Group_ERP_2026_features_Internal.pdf';
const data = new Uint8Array(fs.readFileSync(file));
console.log('Loading PDF...');
const doc = await pdfjsLib.getDocument({ data, disableFontFace: true, isEvalSupported: false }).promise;
console.log('Pages: ' + doc.numPages);
const p = await doc.getPage(1);
const tc = await p.getTextContent();
const t = tc.items.map(x => x.str).join(' ');
console.log('Page 1: ' + t.slice(0, 200));
console.log('SUCCESS');
