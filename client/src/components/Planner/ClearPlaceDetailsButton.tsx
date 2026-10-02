import type { TranslationFn } from '../../types'
import { PROVIDER_DETAIL_FIELDS, type PlaceFormData } from './PlaceFormModal.helpers'

/** Only changes the draft; the ordinary Save/Cancel actions still own persistence. */
export default function ClearPlaceDetailsButton({ form, onClear, t }: {
  form: PlaceFormData
  onClear: () => void
  t: TranslationFn
}) {
  if (!PROVIDER_DETAIL_FIELDS.some(field => form[field])) return null
  return (
    <button
      type="button"
      onClick={onClear}
      className="mt-2 text-caption text-content-muted hover:text-content underline underline-offset-2"
    >
      {t('places.clearProviderDetails')}
    </button>
  )
}
