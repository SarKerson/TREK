import { describe, expect, it } from 'vitest';
import { journeyDirectUploadMetadataSchema, journeyDirectUploadRequestSchema } from './journey.schema';

const file = { fieldname: 'photos', originalName: 'vacation.jpg', contentType: 'image/jpeg', size: 42 };

describe('journey direct upload contracts', () => {
  it('keeps multipart metadata strings and normalizes MIME case', () => {
    expect(journeyDirectUploadRequestSchema.parse({ files: [{ ...file, contentType: 'IMAGE/JPEG' }] })).toEqual({ files: [file], metadata: {} });
    expect(journeyDirectUploadMetadataSchema.parse({ caption: 'Family', duration_ms: '1234' })).toEqual({ caption: 'Family', duration_ms: '1234' });
  });

  it.each(['../escape.jpg', 'path/file.jpg', 'path\\file.jpg', 'bad\rname.jpg'])('rejects unsafe original name %s', originalName => {
    expect(journeyDirectUploadRequestSchema.safeParse({ files: [{ ...file, originalName }] }).success).toBe(false);
  });

  it('rejects unbounded batches, client keys/URLs and unknown fields', () => {
    for (const body of [
      { files: [] },
      { files: Array.from({ length: 101 }, () => file) },
      { files: [{ ...file, pathname: 'journey/someone-else.jpg' }] },
      { files: [{ ...file, url: 'https://example.test/private.jpg' }] },
      { files: [{ ...file, fieldname: 'avatar' }] },
      { files: [file], metadata: { target_id: '99' } },
    ]) expect(journeyDirectUploadRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each(['NaN', 'Infinity', '-1'])('rejects invalid clip duration %s', duration_ms => {
    expect(journeyDirectUploadMetadataSchema.safeParse({ duration_ms }).success).toBe(false);
  });
});
