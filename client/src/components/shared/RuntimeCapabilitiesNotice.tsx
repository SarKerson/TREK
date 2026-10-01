import type { RuntimeCapabilities } from '@trek/shared'
import { useTranslation } from '../../i18n'

/** One notice shared by the desktop and phone shells. */
export default function RuntimeCapabilitiesNotice({ capabilities }: { capabilities?: RuntimeCapabilities }) {
  const { t } = useTranslation()
  if (!capabilities || capabilities.backgroundAutosync) return null
  return (
    <p role="note" className="mb-4 rounded-xl border border-edge bg-surface-secondary p-4 text-sm text-content-secondary">
      {t('common.serverlessLimitations')}
    </p>
  )
}
