import path from 'node:path';
import { BLOCKED_EXTENSIONS } from '../files/files.constants';

export const MAX_NOTE_FILE_SIZE = 50 * 1024 * 1024;
export const MAX_CHAT_IMAGES = 4;
const CHAT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const CHAT_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

export function allowsChatImage(originalName: string, contentType: string): boolean {
  const ext = path.extname(originalName).toLowerCase();
  return CHAT_IMAGE_TYPES.has(contentType) && !BLOCKED_EXTENSIONS.includes(ext) && CHAT_IMAGE_EXTENSIONS.has(ext);
}

export function allowsNoteFile(originalName: string, contentType: string): boolean {
  const ext = path.extname(originalName).toLowerCase();
  return !BLOCKED_EXTENSIONS.includes(ext) && !['svg', 'html', 'javascript'].some(type => contentType.toLowerCase().includes(type));
}
