import { beforeEach, describe, expect, it, vi } from 'vitest'
import { healthApi } from '../api/client'
import { runtimeTabAvailable, useRuntimeCapabilitiesStore } from './runtimeCapabilitiesStore'

vi.mock('../api/client', () => ({ healthApi: { features: vi.fn() } }))
const capabilities = {
  persistentPlugins: false, backgroundAutosync: false, instanceBackupRestore: false,
  mcp: false, privateBlobUploads: true, multipartMaxBytes: 4_000_000,
}
beforeEach(() => {
  vi.clearAllMocks()
  useRuntimeCapabilitiesStore.setState({ capabilities: undefined, status: 'idle' })
})
describe('runtime capability presentation', () => {
  it('hides unavailable tabs while retaining core settings', () => {
    for (const tab of ['plugins', 'backup', 'mcp-tokens', 'storage']) {
      expect(runtimeTabAvailable(tab, capabilities)).toBe(false)
      expect(runtimeTabAvailable(tab)).toBe(true)
    }
    expect(runtimeTabAvailable('users', capabilities)).toBe(true)
  })
  it('loads capabilities once across consumers', async () => {
    vi.mocked(healthApi.features).mockResolvedValue({ bookingImport: false, aiParsing: true, runtimeCapabilities: capabilities })
    await Promise.all([useRuntimeCapabilitiesStore.getState().load(), useRuntimeCapabilitiesStore.getState().load()])
    await useRuntimeCapabilitiesStore.getState().load()
    expect(healthApi.features).toHaveBeenCalledTimes(1)
    expect(useRuntimeCapabilitiesStore.getState().capabilities).toEqual(capabilities)
  })
  it('preserves known restrictions on error and permits a later retry', async () => {
    useRuntimeCapabilitiesStore.setState({ capabilities })
    vi.mocked(healthApi.features).mockRejectedValueOnce(new Error('offline'))
    await useRuntimeCapabilitiesStore.getState().load()
    expect(useRuntimeCapabilitiesStore.getState().status).toBe('error')
    expect(useRuntimeCapabilitiesStore.getState().capabilities).toEqual(capabilities)
    vi.mocked(healthApi.features).mockResolvedValue({ bookingImport: false, aiParsing: false })
    await useRuntimeCapabilitiesStore.getState().load()
    expect(useRuntimeCapabilitiesStore.getState().status).toBe('ready')
    expect(useRuntimeCapabilitiesStore.getState().capabilities).toBeUndefined()
  })
})
