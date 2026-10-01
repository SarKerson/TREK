import { describe, expect, it } from 'vitest';
import { fileDirectUploadRequestSchema, fileDirectUploadGrantSchema, fileDirectUploadCompleteSchema } from './file.schema';
const valid = { originalName: '旅行.pdf', contentType: 'APPLICATION/PDF', size: 10, metadata: { description: 'Ticket' } };
describe('private file upload contracts', () => {
  it('normalizes MIME types and preserves Unicode names', () => expect(fileDirectUploadRequestSchema.parse(valid).contentType).toBe('application/pdf'));
  it.each(['../secret.pdf', 'a/b.pdf', 'a\\b.pdf', 'bad\n.pdf'])('rejects unsafe name %j', originalName => expect(fileDirectUploadRequestSchema.safeParse({ ...valid, originalName }).success).toBe(false));
  it.each([-1, 0.5, 501 * 1024 * 1024])('rejects invalid byte counts %i', size => expect(fileDirectUploadRequestSchema.safeParse({ ...valid, size }).success).toBe(false));
  it('rejects client-provided storage addresses', () => expect(fileDirectUploadRequestSchema.safeParse({ ...valid, pathname: 'foreign.pdf' }).success).toBe(false));
  it('allows only URL generation events, never public callbacks', () => expect(fileDirectUploadGrantSchema.safeParse({ type: 'blob.upload-completed', payload: {} }).success).toBe(false));
  it('finalization only accepts a UUID, never an external URL', () => expect(fileDirectUploadCompleteSchema.safeParse({ id: 'https://example.test/file' }).success).toBe(false));
});
