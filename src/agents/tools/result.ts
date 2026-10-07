import { ImageAttachment } from '../../types';

export interface ToolResult {
  success: boolean;
  output: string;
  /** Images for the model to look at (screenshots, image files), stored by path. */
  images?: ImageAttachment[];
}

export function fail(output: string): ToolResult {
  return { success: false, output };
}

export function ok(output: string, images?: ImageAttachment[]): ToolResult {
  return images?.length ? { success: true, output, images } : { success: true, output };
}
