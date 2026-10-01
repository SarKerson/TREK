import { z } from 'zod';

/** Runtime support is separate from an administrator's addon preferences. */
export const runtimeCapabilitiesSchema = z.object({
  persistentPlugins: z.boolean(),
  backgroundAutosync: z.boolean(),
  instanceBackupRestore: z.boolean(),
  mcp: z.boolean(),
  privateBlobUploads: z.boolean(),
  multipartMaxBytes: z.number().int().positive().nullable(),
});
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>;

export const serverFeaturesSchema = z.object({
  bookingImport: z.boolean(),
  aiParsing: z.boolean(),
  // Older persistent servers omit this field and retain all legacy features.
  runtimeCapabilities: runtimeCapabilitiesSchema.optional(),
});
export type ServerFeatures = z.infer<typeof serverFeaturesSchema>;
