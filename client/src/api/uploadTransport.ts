import type { AxiosInstance } from 'axios'
import {
  fileDirectUploadIntentSchema, fileDirectUploadRequestSchema,
  serverFeaturesSchema, stagedUploadIntentSchema, type RuntimeCapabilities,
} from '@trek/shared'
import type { UploadOptions } from './client'
import type { TripFile } from '../types'

/** Keeps runtime discovery and the two byte transports inside the API layer. */
export class UploadTransport {
  private capabilitiesRequest?: Promise<RuntimeCapabilities | undefined>

  constructor(private readonly api: AxiosInstance) {}

  private capabilities(): Promise<RuntimeCapabilities | undefined> {
    this.capabilitiesRequest ??= this.api.get('/health/features')
      .then(response => serverFeaturesSchema.parse(response.data).runtimeCapabilities)
      .catch(error => {
        this.capabilitiesRequest = undefined
        throw error
      })
    return this.capabilitiesRequest
  }

  async multipart<T>(url: string, data: FormData, opts?: UploadOptions): Promise<T> {
    const capabilities = await this.capabilities()
    if (capabilities?.privateBlobUploads && supportsStagedUpload(url)) {
      return this.staged<T>(url, data, opts)
    }
    if (capabilities?.multipartMaxBytes) {
      let bytes = 0
      for (const [name, value] of data.entries()) {
        bytes += new TextEncoder().encode(name).length + 256
        bytes += value instanceof Blob ? value.size : new TextEncoder().encode(value).length
      }
      if (bytes > capabilities.multipartMaxBytes) {
        throw new Error('This upload is larger than the 4 MB request limit on this deployment. Upload it in Trip Files, or use smaller files here.')
      }
    }
    return this.api.post<T>(url, data, {
      headers: { 'Content-Type': 'multipart/form-data', ...idempotencyHeaders(opts) },
      timeout: 0, signal: opts?.signal, onUploadProgress: opts?.onUploadProgress,
    }).then(response => response.data)
  }

  async tripFile(tripId: number | string, data: FormData, opts?: UploadOptions): Promise<{ file: TripFile }> {
    const path = `/trips/${tripId}/files`
    if (!(await this.capabilities())?.privateBlobUploads) return this.multipart(path, data, opts)
    const file = data.get('file')
    if (!(file instanceof File)) throw new Error('No file uploaded')
    const metadata = Object.fromEntries([...data.entries()].filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    const request = fileDirectUploadRequestSchema.parse({
      originalName: file.name, size: file.size,
      contentType: file.type || 'application/octet-stream', metadata,
    })
    const intent = fileDirectUploadIntentSchema.parse((await this.api.post(`${path}/direct-upload`, request, {
      headers: idempotencyHeaders(opts, ':intent'), signal: opts?.signal,
    })).data)
    const { uploadPresigned } = await import('@vercel/blob/client')
    let previousLoaded = 0
    await uploadPresigned(intent.pathname, file, {
      access: 'private', contentType: intent.contentType, multipart: file.size > 5 * 1024 * 1024,
      handleUploadUrl: `/api${path}/direct-upload/grant`, clientPayload: intent.id,
      abortSignal: opts?.signal,
      onUploadProgress: ({ loaded, total, percentage }) => {
        const bytes = loaded - previousLoaded
        previousLoaded = loaded
        opts?.onUploadProgress?.({ loaded, total, progress: percentage / 100, bytes, lengthComputable: true, upload: true })
      },
    })
    return this.api.post<{ file: TripFile }>(`${path}/direct-upload/complete`, { id: intent.id }, {
      headers: idempotencyHeaders(opts, ':complete'), signal: opts?.signal, timeout: 0,
    }).then(response => response.data)
  }

  private async staged<T>(url: string, data: FormData, opts?: UploadOptions): Promise<T> {
    const entries = [...data.entries()]
    const selected = entries.filter((entry): entry is [string, File] => entry[1] instanceof File)
    const metadata = Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    // A text-only chat FormData still uses its original handler.
    if (!selected.length) return this.api.post<T>(url, metadata, { signal: opts?.signal, headers: idempotencyHeaders(opts) }).then(r => r.data)
    const descriptors = selected.map(([fieldname, file]) => ({ fieldname, originalName: file.name,
      size: file.size, contentType: file.type || 'application/octet-stream' }))
    const intent = stagedUploadIntentSchema.parse((await this.api.post(`${url}/direct-upload`, { files: descriptors, metadata }, {
      headers: idempotencyHeaders(opts, ':intent'), signal: opts?.signal,
    })).data)
    if (intent.files.length !== selected.length) throw new Error('Upload grant did not match the selected files')
    const { uploadPresigned } = await import('@vercel/blob/client')
    const total = selected.reduce((sum, [, file]) => sum + file.size, 0)
    let finishedBytes = 0
    let previousLoaded = 0
    for (const [index, [, file]] of selected.entries()) {
      const target = intent.files[index]
      if (!target || target.size !== file.size || target.fieldname !== selected[index][0]) throw new Error('Upload grant did not match the selected files')
      await uploadPresigned(target.pathname, file, {
        access: 'private', contentType: target.contentType, multipart: file.size > 5 * 1024 * 1024,
        handleUploadUrl: '/api/uploads/grant', clientPayload: intent.id, abortSignal: opts?.signal,
        onUploadProgress: event => {
          const loaded = finishedBytes + event.loaded
          const bytes = loaded - previousLoaded
          previousLoaded = loaded
          opts?.onUploadProgress?.({ loaded, total, progress: total ? loaded / total : 1, bytes, lengthComputable: true, upload: true })
        },
      })
      finishedBytes += file.size
    }
    return this.api.post<T>(`${url}/direct-upload/complete`, { id: intent.id }, {
      headers: idempotencyHeaders(opts, ':complete'), signal: opts?.signal, timeout: 0,
    }).then(response => response.data)
  }
}

function supportsStagedUpload(url: string): boolean {
  return /^\/journeys\/entries\/[^/]+\/(photos|video)$/.test(url)
    || /^\/journeys\/[^/]+\/(gallery\/(photos|video)|cover)$/.test(url)
    || /^\/trips\/[^/]+\/collab\/(notes\/[^/]+\/files|messages)$/.test(url)
}

function idempotencyHeaders(opts?: UploadOptions, suffix = ''): Record<string, string> {
  return opts?.idempotencyKey ? { 'X-Idempotency-Key': `${opts.idempotencyKey}${suffix}` } : {}
}
