import { create } from 'zustand'
import type { RuntimeCapabilities } from '@trek/shared'
import { healthApi } from '../api/client'

interface RuntimeState {
  capabilities: RuntimeCapabilities | undefined
  status: 'idle' | 'loading' | 'ready' | 'error'
  load: () => Promise<void>
}

export const useRuntimeCapabilitiesStore = create<RuntimeState>((set, get) => ({
  capabilities: undefined,
  status: 'idle',
  load: async () => {
    if (get().status === 'loading' || get().status === 'ready') return
    set({ status: 'loading' })
    try {
      const features = await healthApi.features()
      set({ capabilities: features.runtimeCapabilities, status: 'ready' })
    } catch {
      // Keep previously known restrictions during an offline session.
      set({ status: 'error' })
    }
  },
}))

export function runtimeTabAvailable(tab: string, capabilities?: RuntimeCapabilities): boolean {
  if (!capabilities) return true
  if (tab === 'plugins') return capabilities.persistentPlugins
  if (tab === 'backup') return capabilities.instanceBackupRestore
  if (tab === 'mcp-tokens') return capabilities.mcp
  // The Blob backend is deployment configuration, not an in-app migration.
  if (tab === 'storage') return !capabilities.privateBlobUploads
  return true
}
