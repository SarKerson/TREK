import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import RuntimeCapabilitiesNotice from './RuntimeCapabilitiesNotice'

vi.mock('../../i18n', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
it('only explains limitations for a runtime without background autosync', () => {
  const { rerender } = render(<RuntimeCapabilitiesNotice />)
  expect(screen.queryByRole('note')).toBeNull()
  const capabilities = { persistentPlugins: false, backgroundAutosync: false, instanceBackupRestore: false, mcp: false, privateBlobUploads: true, multipartMaxBytes: 4_000_000 }
  rerender(<RuntimeCapabilitiesNotice capabilities={capabilities} />)
  expect(screen.getByRole('note')).toHaveTextContent('common.serverlessLimitations')
  rerender(<RuntimeCapabilitiesNotice capabilities={{ ...capabilities, backgroundAutosync: true }} />)
  expect(screen.queryByRole('note')).toBeNull()
})
