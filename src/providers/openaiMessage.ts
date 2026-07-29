import { Message } from '../types';

/** Converts a Message to the OpenAI chat-completions shape, promoting it to the
 *  multimodal content-array form only when hydrated images are attached — a
 *  plain string keeps maximum compatibility with the many OpenAI-compatible
 *  endpoints (opencode-zen, local servers) that never accept content arrays. */
export function toOpenAIMessage(m: Message): { role: string; content: any } {
  const images = (m.images || []).filter(img => !!img.data);
  if (images.length === 0) {
    return { role: m.role, content: m.content };
  }

  const parts: any[] = images.map(img => ({
    type: 'image_url',
    image_url: { url: `data:${img.mediaType};base64,${img.data}` },
  }));
  if (m.content) {
    parts.push({ type: 'text', text: m.content });
  }
  return { role: m.role, content: parts };
}
