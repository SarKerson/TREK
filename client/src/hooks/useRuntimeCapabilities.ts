import { useEffect } from 'react'
import { useRuntimeCapabilitiesStore } from '../store/runtimeCapabilitiesStore'

export function useRuntimeCapabilities() {
  const capabilities = useRuntimeCapabilitiesStore(s => s.capabilities)
  const load = useRuntimeCapabilitiesStore(s => s.load)
  useEffect(() => { void load() }, [load])
  return capabilities
}
