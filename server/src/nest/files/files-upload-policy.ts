import path from 'node:path';
import { BLOCKED_EXTENSIONS, isVideoExtension } from './files.constants';

/** The same allow/block policy applies before multipart parsing and before a direct grant. */
export function isAllowedFileType(originalName: string, contentType: string, allowedTypes: string): boolean {
  const ext = path.extname(originalName).toLowerCase();
  if (BLOCKED_EXTENSIONS.includes(ext) || contentType.toLowerCase().includes('svg')) return false;
  const allowed = allowedTypes.split(',').map(value => value.trim().toLowerCase());
  return allowed.includes(ext.slice(1)) || isVideoExtension(ext) || allowed.includes('*');
}
