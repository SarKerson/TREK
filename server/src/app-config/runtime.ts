/** Vercel's filesystem and process lifetime are never durable application state. */
export function isVercelRuntime(): boolean {
  return process.env.VERCEL === '1';
}

/** Stable, separately provisioned secrets are mandatory in an ephemeral runtime. */
export function vercelSecrets(): { jwt: string; encryption: string } | null {
  if (!isVercelRuntime()) return null;
  const jwt = process.env.JWT_SECRET?.trim();
  const encryption = process.env.ENCRYPTION_KEY?.trim();
  if (!jwt || jwt.length < 32 || !encryption || encryption.length < 32) {
    throw new Error('Vercel requires JWT_SECRET and ENCRYPTION_KEY of at least 32 characters');
  }
  if (jwt === encryption) throw new Error('JWT_SECRET and ENCRYPTION_KEY must be distinct');
  return { jwt, encryption };
}

/** A remote-only connection: never create a local replica in a serverless function. */
export function readRemoteDatabaseConfig(): { url: string; authToken: string } | null {
  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!url && !authToken && !isVercelRuntime()) return null;
  if (!url || !authToken) throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required together');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid TURSO_DATABASE_URL');
  }
  if (
    !['libsql:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'TURSO_DATABASE_URL must be a libsql:// or https:// endpoint without credentials, query or fragment',
    );
  }
  return { url, authToken };
}

/** Store binding uses Vercel OIDC; legacy tokens are an explicit fallback. */
export function readBlobStorageConfig(): { storeId?: string; token?: string } {
  const storeId = process.env.BLOB_STORE_ID?.trim();
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (storeId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(storeId)) throw new Error('BLOB_STORE_ID is invalid');
    return { storeId };
  }
  if (token) return { token };
  throw new Error('BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN is required for durable file storage');
}
