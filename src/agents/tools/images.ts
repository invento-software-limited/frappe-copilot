import * as fs from 'fs';
import * as path from 'path';
import { ImageAttachment } from '../../types';

/** The image formats every vision-capable provider here accepts. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Anthropic rejects images over ~5MB — checked before the request is sent. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function imageMediaType(fileName: string): string | undefined {
  return IMAGE_MEDIA_TYPES[path.extname(fileName).toLowerCase()];
}

/** An image file as an attachment the model can see, or a reason it can't be. */
export function imageAttachment(absPath: string): { image?: ImageAttachment; problem?: string } {
  const mediaType = imageMediaType(absPath);
  if (!mediaType) return { problem: 'not a png, jpeg, gif or webp image' };
  const size = fs.statSync(absPath).size;
  if (size > MAX_IMAGE_BYTES) return { problem: `${(size / 1048576).toFixed(1)}MB is over the ${MAX_IMAGE_BYTES / 1048576}MB image limit` };
  return { image: { mediaType, name: path.basename(absPath), path: absPath } };
}
