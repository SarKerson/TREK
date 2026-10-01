import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDay, buildPlace, buildReservation } from '../../../tests/helpers/factories';
import { fireEvent, render, screen, waitFor } from '../../../tests/helpers/render';
import { resetAllStores } from '../../../tests/helpers/store';
import type { BookingReviewDraft } from './parsedItemToDraft';
import { ReservationModal } from './ReservationModal';

function props(): ComponentProps<typeof ReservationModal> {
  return {
    isOpen: true,
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    reservation: null,
    days: [buildDay({ id: 1 })],
    places: [],
    assignments: {},
    selectedDayId: 1,
    accommodations: [],
    onFileDelete: vi.fn().mockResolvedValue(undefined),
  };
}

const titleField = () => screen.getByPlaceholderText(/e\.g\. Lufthansa/i);
const notesField = () => screen.getByPlaceholderText('Additional notes...');

function fillHotelDraft() {
  fireEvent.click(screen.getByRole('button', { name: 'Accommodation' }));
  fireEvent.change(titleField(), { target: { value: 'Family hotel' } });
  fireEvent.change(notesField(), { target: { value: 'Breakfast included' } });
  fireEvent.click(screen.getByRole('button', { name: 'Pending' }));
  fireEvent.click(screen.getByText('Confirmed'));
}

function expectHotelDraft() {
  expect(titleField()).toHaveValue('Family hotel');
  expect(notesField()).toHaveValue('Breakfast included');
  expect(screen.getByRole('button', { name: 'Accommodation' })).toHaveClass('bg-[var(--text-primary)]');
  expect(screen.getByRole('button', { name: 'Confirmed' })).toBeInTheDocument();
}

beforeEach(resetAllStores);

describe('ReservationModal refreshes', () => {
  it.each(['days', 'places', 'accommodations'] as const)(
    'preserves and saves a new hotel draft when %s refresh while confirming it',
    async (field) => {
      const initial = props();
      const { rerender } = render(<ReservationModal {...initial} />);
      fillHotelDraft();
      expectHotelDraft();

      const refreshed = { ...initial, [field]: [...initial[field]!] };
      rerender(<ReservationModal {...refreshed} />);
      expectHotelDraft();

      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      await waitFor(() =>
        expect(initial.onSave).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Family hotel',
            notes: 'Breakfast included',
            type: 'hotel',
            status: 'confirmed',
          })
        )
      );
    }
  );

  it('keeps edited fields and travelers when the same reservation is refreshed', () => {
    const initial = {
      ...props(),
      reservation: buildReservation({ id: 10, type: 'hotel', status: 'pending', title: 'Saved hotel' }),
      tripMembers: [{ id: 1, username: 'alice', avatar_url: null }],
    };
    const { rerender } = render(<ReservationModal {...initial} />);
    fillHotelDraft();
    fireEvent.click(screen.getByRole('button', { name: /alice/i }));

    rerender(<ReservationModal {...initial} reservation={{ ...initial.reservation, notes: 'Remote notes' }} />);
    expectHotelDraft();
    expect(screen.getByRole('button', { name: /alice/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('preserves pending attachments and traveler choices across refreshes, then clears a new draft on reopening', () => {
    const initial = {
      ...props(),
      onFileUpload: vi.fn().mockResolvedValue(undefined),
      tripMembers: [{ id: 1, username: 'alice', avatar_url: null }],
    };
    const { rerender } = render(<ReservationModal {...initial} />);
    fillHotelDraft();
    fireEvent.click(screen.getByRole('button', { name: /alice/i }));
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['booking'], 'hotel.pdf', { type: 'application/pdf' })] },
    });
    const refreshed = { ...initial, places: [buildPlace({ name: 'New place' })] };
    rerender(<ReservationModal {...refreshed} />);
    expectHotelDraft();
    expect(screen.getByText('hotel.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /alice/i })).toHaveAttribute('aria-pressed', 'true');

    rerender(<ReservationModal {...refreshed} isOpen={false} />);
    rerender(<ReservationModal {...refreshed} />);
    expect(titleField()).toHaveValue('');
    expect(notesField()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Other' })).toHaveClass('bg-[var(--text-primary)]');
    expect(screen.getByRole('button', { name: 'Pending' })).toBeInTheDocument();
    expect(screen.queryByText('hotel.pdf')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /alice/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('loads the current saved values when reopening the same reservation', () => {
    const initial = { ...props(), reservation: buildReservation({ id: 10, type: 'hotel', status: 'pending' }) };
    const { rerender } = render(<ReservationModal {...initial} />);
    fillHotelDraft();
    const refreshed = { ...initial.reservation, title: 'Latest saved hotel', notes: 'Latest saved notes' };

    rerender(<ReservationModal {...initial} reservation={refreshed} isOpen={false} />);
    rerender(<ReservationModal {...initial} reservation={refreshed} />);
    expect(titleField()).toHaveValue('Latest saved hotel');
    expect(notesField()).toHaveValue('Latest saved notes');
    expect(screen.getByRole('button', { name: 'Pending' })).toBeInTheDocument();
  });

  it('loads a different reservation while open and clears it when switching to create', () => {
    const initial = { ...props(), reservation: buildReservation({ id: 10, type: 'hotel', status: 'pending' }) };
    const { rerender } = render(<ReservationModal {...initial} />);
    fillHotelDraft();
    const next = buildReservation({
      id: 11,
      title: 'Dinner',
      type: 'restaurant',
      notes: 'Window seat',
      status: 'pending',
    });
    rerender(<ReservationModal {...initial} reservation={next} />);
    expect(titleField()).toHaveValue('Dinner');
    expect(notesField()).toHaveValue('Window seat');
    expect(screen.getByRole('button', { name: 'Restaurant' })).toHaveClass('bg-[var(--text-primary)]');
    expect(screen.getByRole('button', { name: 'Pending' })).toBeInTheDocument();

    rerender(<ReservationModal {...initial} reservation={null} />);
    expect(titleField()).toHaveValue('');
    expect(notesField()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Other' })).toHaveClass('bg-[var(--text-primary)]');
  });

  it('preserves an import review during refreshes but seeds the next imported item and its files', () => {
    const prefill: BookingReviewDraft = {
      title: 'Imported hotel',
      type: 'hotel',
      _sourceFiles: [new File(['first'], 'first.pdf', { type: 'application/pdf' })],
    };
    const initial = { ...props(), prefill, onFileUpload: vi.fn().mockResolvedValue(undefined) };
    const { rerender } = render(<ReservationModal {...initial} />);
    fillHotelDraft();
    rerender(<ReservationModal {...initial} places={[buildPlace({ name: 'Another place' })]} />);
    expectHotelDraft();
    expect(screen.getByText('first.pdf')).toBeInTheDocument();

    const next: BookingReviewDraft = {
      title: 'Imported dinner',
      type: 'restaurant',
      notes: 'Second item',
      _sourceFiles: [new File(['second'], 'second.pdf', { type: 'application/pdf' })],
    };
    rerender(<ReservationModal {...initial} prefill={next} />);
    expect(titleField()).toHaveValue('Imported dinner');
    expect(notesField()).toHaveValue('Second item');
    expect(screen.getByRole('button', { name: 'Restaurant' })).toHaveClass('bg-[var(--text-primary)]');
    expect(screen.queryByText('first.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('second.pdf')).toBeInTheDocument();
  });

  it('uses the latest linked hotel data when the modal opens', () => {
    const initial = {
      ...props(),
      isOpen: false,
      reservation: buildReservation({ id: 10, type: 'hotel', accommodation_id: 7 }),
    };
    const { rerender } = render(<ReservationModal {...initial} />);
    rerender(
      <ReservationModal
        {...initial}
        isOpen
        places={[buildPlace({ id: 3, name: 'Linked hotel', address: 'Current address' })]}
        accommodations={[{ id: 7, trip_id: 1, place_id: 3, start_day_id: 1, end_day_id: 1 }]}
      />
    );
    expect(screen.getByDisplayValue('Current address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Linked hotel' })).toBeInTheDocument();
  });
});
