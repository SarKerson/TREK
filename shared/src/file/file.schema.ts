import { z } from 'zod';

/**
 * File + photo API contract.
 *
 * Files live under /api/trips/:tripId/files (upload, metadata, star, trash,
 * reservation links, authenticated download). Photos live under /api/photos
 * (thumbnail/original streaming + info) and are global, not trip-scoped.
 *
 * Uploads are multipart/form-data so the file itself isn't modelled here; these
 * schemas pin the JSON-ish metadata fields that ride along or come as request
 * bodies. The bespoke 400/403/404 controller messages pin the rest.
 */

const nullableIdField = z.union([z.string(), z.number()]).nullable().optional();

/**
 * Multipart text fields riding along with the upload — always strings on the
 * wire (multipart/form-data has no other type), so no numeric coercion here.
 */
export const fileUploadRequestSchema = z.object({
  place_id: z.string().optional(),
  description: z.string().optional(),
  reservation_id: z.string().optional(),
  budget_item_id: z.string().optional(),
});
export type FileUploadRequest = z.infer<typeof fileUploadRequestSchema>;

/** JSON control plane for private direct-to-storage uploads. Bytes never pass through the API. */
export const fileDirectUploadRequestSchema = z.object({
  originalName: z.string().min(1).max(255).refine(
    name => ![...name].some(char => char === '/' || char === '\\' || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    'Invalid filename',
  ),
  contentType: z.string().max(255).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).transform(value => value.toLowerCase()),
  size: z.number().int().min(0).max(500 * 1024 * 1024),
  metadata: fileUploadRequestSchema,
}).strict();
export type FileDirectUploadRequest = z.infer<typeof fileDirectUploadRequestSchema>;

export const fileDirectUploadIntentSchema = z.object({
  id: z.string().uuid(),
  pathname: z.string(),
  expiresAt: z.number().int(),
  contentType: z.string(),
});
export type FileDirectUploadIntent = z.infer<typeof fileDirectUploadIntentSchema>;

export const fileDirectUploadCompleteSchema = z.object({ id: z.string().uuid() }).strict();
export type FileDirectUploadComplete = z.infer<typeof fileDirectUploadCompleteSchema>;

export const fileUpdateRequestSchema = z.object({
  description: z.string().optional(),
  place_id: nullableIdField,
  reservation_id: nullableIdField,
  budget_item_id: nullableIdField,
});
export type FileUpdateRequest = z.infer<typeof fileUpdateRequestSchema>;

export const fileLinkRequestSchema = z.object({
  reservation_id: nullableIdField,
  assignment_id: nullableIdField,
  place_id: nullableIdField,
  budget_item_id: nullableIdField,
});
export type FileLinkRequest = z.infer<typeof fileLinkRequestSchema>;

/** Variants the photo streaming endpoints accept. */
export const photoVariantSchema = z.enum(['thumbnail', 'original']);
export type PhotoVariant = z.infer<typeof photoVariantSchema>;

/** Only the authenticated URL-generation event is accepted; no public callback is installed. */
export const fileDirectUploadGrantSchema = z.object({
  type: z.literal('blob.generate-presigned-url'),
  payload: z.object({ pathname: z.string(), clientPayload: z.string().uuid(), multipart: z.boolean() }).strict(),
}).strict();
export type FileDirectUploadGrant = z.infer<typeof fileDirectUploadGrantSchema>;

/** Domains add their own metadata schema and enforce their original per-field limits. */
export const stagedUploadFileSchema = fileDirectUploadRequestSchema.omit({ metadata: true }).extend({
  fieldname: z.string().min(1).max(32),
});
export type StagedUploadFile = z.infer<typeof stagedUploadFileSchema>;
export const stagedUploadFilesSchema = z.array(stagedUploadFileSchema).min(1).max(100);
export const stagedUploadIntentSchema = z.object({
  id: z.string().uuid(),
  expiresAt: z.number().int(),
  files: z.array(stagedUploadFileSchema.extend({ filename: z.string(), pathname: z.string() }).strip()),
});
