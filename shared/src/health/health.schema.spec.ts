import { runtimeCapabilitiesSchema, serverFeaturesSchema } from './health.schema';

import { describe, expect, it } from 'vitest';

const capabilities = {
  persistentPlugins: false,
  backgroundAutosync: false,
  instanceBackupRestore: false,
  mcp: false,
  privateBlobUploads: true,
  multipartMaxBytes: 4_000_000,
};
describe('runtime capabilities', () => {
  it('retains compatibility with persistent servers', () => {
    expect(serverFeaturesSchema.parse({ bookingImport: false, aiParsing: false })).toEqual({
      bookingImport: false,
      aiParsing: false,
    });
  });
  it('describes the serverless cut and upload limits', () => {
    expect(runtimeCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(runtimeCapabilitiesSchema.parse({ ...capabilities, multipartMaxBytes: null }).multipartMaxBytes).toBeNull();
  });
  it('rejects missing capabilities and invalid upload limits', () => {
    expect(runtimeCapabilitiesSchema.safeParse({ mcp: false }).success).toBe(false);
    for (const multipartMaxBytes of [0, -1, 1.5, '4000000']) {
      expect(runtimeCapabilitiesSchema.safeParse({ ...capabilities, multipartMaxBytes }).success).toBe(false);
    }
  });
});
