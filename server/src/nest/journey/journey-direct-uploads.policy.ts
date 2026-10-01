import { HttpException } from '@nestjs/common';
import path from 'node:path';
import type { StagedUploadFile } from '@trek/shared';
import { BLOCKED_EXTENSIONS, MAX_VIDEO_SIZE, isVideoExtension, isVideoMime } from '../files/files.constants';

export const JOURNEY_UPLOAD_SCOPES = ['journey-entry-photos', 'journey-entry-video',
  'journey-gallery-photos', 'journey-gallery-video', 'journey-cover'] as const;
export type JourneyUploadScope = (typeof JOURNEY_UPLOAD_SCOPES)[number];

const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

function reject(message: string): never {
  throw new HttpException({ error: message }, 400);
}

/** The same fields, MIME filters, extension policy and byte limits as multipart. */
export function validateJourneyUploadFiles(scope: JourneyUploadScope, files: readonly StagedUploadFile[], allowedTypes: string): void {
  const video = scope.endsWith('-video');
  const cover = scope === 'journey-cover';
  if (video) {
    if (files.filter(file => file.fieldname === 'video').length !== 1 ||
      files.filter(file => file.fieldname === 'poster').length > 1 ||
      files.some(file => file.fieldname !== 'video' && file.fieldname !== 'poster')) reject('One video and an optional poster are required');
  } else if (!files.length || (cover && files.length !== 1) ||
    files.some(file => file.fieldname !== (cover ? 'cover' : 'photos'))) {
    reject(cover ? 'One cover image is required' : 'Only photos are allowed');
  }

  const allowed = allowedTypes.split(',').map(extension => extension.trim().toLowerCase());
  for (const file of files) {
    if (file.size <= 0 || file.size > (video ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE)) reject('File is too large or empty');
    const ext = path.extname(file.originalName).toLowerCase();
    if (file.fieldname === 'video') {
      if (!isVideoMime(file.contentType)) reject('Only video files are allowed');
      if (!isVideoExtension(ext)) reject(`Video type ${ext} is not allowed`);
      continue;
    }
    if (!file.contentType.startsWith('image/') || file.contentType.includes('svg')) reject('Only image files are allowed');
    // Posters get a server-selected .jpg name, just like the multipart route.
    if (file.fieldname === 'poster') continue;
    // A wildcard must never admit HTML or script objects served same-origin.
    if (BLOCKED_EXTENSIONS.includes(ext) || (!allowed.includes('*') && !allowed.includes(ext.slice(1)))) {
      reject(`File type ${ext} is not allowed`);
    }
  }
}
