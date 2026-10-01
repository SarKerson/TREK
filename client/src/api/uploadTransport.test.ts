import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import { uploadPresigned } from '@vercel/blob/client'
import { UploadTransport } from './uploadTransport'
vi.mock('@vercel/blob/client', () => ({ uploadPresigned: vi.fn() }))
const id = 'f3a612c5-7016-4ff6-8542-965e8a3fd4cc'
const runtimeCapabilities = { persistentPlugins: false, backgroundAutosync: false, instanceBackupRestore: false, mcp: false, privateBlobUploads: true, multipartMaxBytes: 4_000_000 }
const get = vi.fn(); const post = vi.fn()
let transport: UploadTransport
beforeEach(() => {
  vi.resetAllMocks()
  get.mockResolvedValue({ data: { bookingImport: false, aiParsing: false, runtimeCapabilities } })
  post.mockImplementation(async (url: string, data: { files?: Array<{fieldname: string;originalName: string;size: number;contentType: string}>; contentType?: string }) => {
    if (url.endsWith('/direct-upload/complete')) return { data: { file: { id: 1 }, photos: [{ id: 2 }] } }
    if (url.endsWith('/direct-upload') && data.files) return { data: { id, expiresAt: Date.now() + 3600000,
      files: data.files.map((f, i) => ({ ...f, filename: `f${i}.png`, pathname: `journey/f${i}.png` })) } }
    if (url.endsWith('/direct-upload')) return { data: { id, pathname: 'files/server.pdf', contentType: data.contentType, expiresAt: Date.now() + 3600000 } }
    return { data: { ok: true } }
  })
  transport = new UploadTransport({ get, post } as unknown as AxiosInstance)
})
const fd = (field: string, bytes = 10, name = 'picture.png', type = 'image/png') => {
  const data = new FormData(); data.append(field, new File([new Uint8Array(bytes)], name, { type })); return data
}
describe('private upload transport', () => {
  it('uses an authenticated intent, private SDK bytes and ID-only finalization', async () => {
    const data = fd('file', 6_000_000, 'ticket.pdf', 'application/pdf')
    const signal = new AbortController().signal
    await transport.tripFile(9, data, { signal, idempotencyKey: 'retry' })
    expect(post.mock.calls[0][0]).toBe('/trips/9/files/direct-upload')
    expect(uploadPresigned).toHaveBeenCalledWith('files/server.pdf', data.get('file'), expect.objectContaining({ access: 'private', multipart: true, clientPayload: id, handleUploadUrl: '/api/trips/9/files/direct-upload/grant', abortSignal: signal }))
    expect(post.mock.calls[1]).toEqual(['/trips/9/files/direct-upload/complete', { id }, expect.objectContaining({ headers: { 'X-Idempotency-Key': 'retry:complete' }, timeout: 0, signal })])
  })
  it.each(['/journeys/entries/3/photos', '/journeys/3/gallery/photos', '/journeys/entries/3/video', '/journeys/3/gallery/video', '/journeys/3/cover', '/trips/2/collab/notes/3/files', '/trips/2/collab/messages'])('stages large media at %s', async url => {
    const data = fd('photos', 4_100_000)
    await transport.multipart(url, data)
    expect(post.mock.calls[0][0]).toBe(`${url}/direct-upload`)
    expect(uploadPresigned).toHaveBeenCalledWith('journey/f0.png', data.get('photos'), expect.objectContaining({ handleUploadUrl: '/api/uploads/grant', access: 'private' }))
    expect(post.mock.calls[1][0]).toBe(`${url}/direct-upload/complete`)
  })
  it('never finalizes when bytes fail or upload is cancelled', async () => {
    vi.mocked(uploadPresigned).mockRejectedValue(new Error('cancelled'))
    await expect(transport.tripFile(1, fd('file'))).rejects.toThrow('cancelled')
    expect(post).toHaveBeenCalledTimes(1)
  })
  it('rejects a remaining oversized multipart request before sending its bytes', async () => {
    await expect(transport.multipart('/auth/avatar', fd('avatar', 4_100_000))).rejects.toThrow('4 MB')
    expect(post).not.toHaveBeenCalled()
  })
  it('enforces the whole-request total, including several smaller files', async () => {
    const data = fd('files', 2_100_000); data.append('files', new File([new Uint8Array(2_100_000)], 'second.pdf'))
    await expect(transport.multipart('/trips/2/reservations/import/booking', data)).rejects.toThrow('4 MB')
    expect(post).not.toHaveBeenCalled()
  })
  it('keeps legacy multipart servers and their no-timeout behavior', async () => {
    get.mockResolvedValue({ data: { bookingImport: false, aiParsing: false } })
    const data = fd('file', 4_100_000)
    await transport.tripFile(1, data)
    expect(post).toHaveBeenCalledWith('/trips/1/files', data, expect.objectContaining({ timeout: 0 }))
    expect(uploadPresigned).not.toHaveBeenCalled()
  })
  it('does not cache a failed runtime lookup or silently change transport', async () => {
    get.mockRejectedValueOnce(new Error('offline'))
    await expect(transport.tripFile(1, fd('file'))).rejects.toThrow('offline')
    expect(post).not.toHaveBeenCalled()
    await transport.tripFile(1, fd('file'))
    expect(get).toHaveBeenCalledTimes(2)
  })
})
