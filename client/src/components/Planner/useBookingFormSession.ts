import { useEffect, useEffectEvent } from 'react';
import type { Reservation } from '../../types';
import type { BookingReviewDraft } from './parsedItemToDraft';

interface BookingFormSession {
  isOpen: boolean;
  reservation: Pick<Reservation, 'id'> | null;
  prefill: BookingReviewDraft | null;
}

/** Seed an editor once per open/record, without overwriting its draft on trip refreshes. */
export function useBookingFormSession({ isOpen, reservation, prefill }: BookingFormSession, initialize: () => void) {
  // Initialization reads the latest linked days, places and costs when a session
  // starts. Those live collections must not become reset triggers themselves.
  const initializeForm = useEffectEvent(initialize);
  const reservationId = reservation?.id;
  // Import drafts have no persisted id. The review queue holds one object per
  // item, replacing it when advancing to the next booking, even if it looks alike.
  const importDraft = reservation ? null : prefill;

  useEffect(() => {
    if (isOpen) initializeForm();
  }, [isOpen, reservationId, importDraft]);
}
