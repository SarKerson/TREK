import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBudgetItem, buildDay, buildReservation, buildTrip } from '../../../tests/helpers/factories';
import { act, fireEvent, render, screen, waitFor } from '../../../tests/helpers/render';
import { resetAllStores, seedStore } from '../../../tests/helpers/store';
import { useTripStore } from '../../store/tripStore';
import type AirportSelect from './AirportSelect';
import type LocationSelect from './LocationSelect';
import type { BookingReviewDraft } from './parsedItemToDraft';
import { TransportModal } from './TransportModal';

vi.mock('../shared/CustomTimePicker', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <input aria-label="Time" value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));

// Keep location controls controlled: a reset must be visible in both the UI and
// the eventual save, without making these editor tests depend on search APIs.
vi.mock('./AirportSelect', () => ({
  default: ({ value, onChange }: ComponentProps<typeof AirportSelect>) => (
    <input
      aria-label="Airport"
      value={value?.iata ?? ''}
      onChange={(event) =>
        onChange({
          iata: event.target.value,
          icao: null,
          name: event.target.value,
          city: '',
          country: '',
          lat: 0,
          lng: 0,
          tz: 'UTC',
        })
      }
    />
  ),
}));

vi.mock('./LocationSelect', () => ({
  default: ({ value, onChange }: ComponentProps<typeof LocationSelect>) => (
    <input
      aria-label="Station or location"
      value={value?.name ?? ''}
      onChange={(event) =>
        onChange({
          name: event.target.value,
          lat: 0,
          lng: 0,
          address: null,
        })
      }
    />
  ),
}));

function props(): ComponentProps<typeof TransportModal> {
  return {
    isOpen: true,
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    reservation: null,
    days: [
      buildDay({ id: 1, date: '2026-10-01', day_number: 1 }),
      buildDay({ id: 2, date: '2026-10-02', day_number: 2 }),
    ],
    selectedDayId: 1,
    onFileUpload: vi.fn().mockResolvedValue(undefined),
    tripMembers: [{ id: 1, username: 'alice', avatar_url: null }],
  };
}

const titleField = () => screen.getByPlaceholderText(/e\.g\. Lufthansa/i);
const notesField = () => screen.getByPlaceholderText('Additional notes...');
const change = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });

function refreshBudget() {
  act(() => useTripStore.setState({ budgetItems: [buildBudgetItem({ name: 'Refreshed cost' })] }));
}

function fillFlightDraft() {
  change(titleField(), 'Family flight');
  change(notesField(), 'Keep this unsaved note');
  change(screen.getByPlaceholderText('e.g. ABC12345'), 'FAMILY1');
  change(screen.getAllByRole('textbox', { name: 'Airport' })[0], 'LHR');
  change(screen.getAllByRole('textbox', { name: 'Airport' })[1], 'JFK');
  change(screen.getAllByRole('textbox', { name: 'Time' })[0], '09:10');
  change(screen.getAllByRole('textbox', { name: 'Time' })[1], '13:20');
  change(screen.getByPlaceholderText('Lufthansa'), 'Example Air');
  change(screen.getByPlaceholderText('LH 123'), 'EA 123');
  change(screen.getByPlaceholderText('12A'), '4F');
  fireEvent.click(screen.getByRole('button', { name: 'Pending' }));
  fireEvent.click(screen.getByText('Confirmed'));
}

function expectFlightDraft() {
  expect(titleField()).toHaveValue('Family flight');
  expect(notesField()).toHaveValue('Keep this unsaved note');
  expect(screen.getByPlaceholderText('e.g. ABC12345')).toHaveValue('FAMILY1');
  expect(screen.getAllByRole('textbox', { name: 'Airport' })[0]).toHaveValue('LHR');
  expect(screen.getAllByRole('textbox', { name: 'Airport' })[1]).toHaveValue('JFK');
  expect(screen.getAllByRole('textbox', { name: 'Time' })[0]).toHaveValue('09:10');
  expect(screen.getAllByRole('textbox', { name: 'Time' })[1]).toHaveValue('13:20');
  expect(screen.getByPlaceholderText('Lufthansa')).toHaveValue('Example Air');
  expect(screen.getByPlaceholderText('LH 123')).toHaveValue('EA 123');
  expect(screen.getByPlaceholderText('12A')).toHaveValue('4F');
  expect(screen.getByRole('button', { name: 'Confirmed' })).toBeInTheDocument();
}

beforeEach(() => {
  resetAllStores();
  seedStore(useTripStore, { trip: buildTrip({ id: 1 }), budgetItems: [] });
});

describe('TransportModal refreshes', () => {
  it('preserves and saves a dirty flight, travelers and pending files after a budget refresh', async () => {
    const initial = props();
    render(<TransportModal {...initial} />);
    fillFlightDraft();
    fireEvent.click(screen.getByRole('button', { name: /alice/i }));
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['boarding pass'], 'boarding.pdf', { type: 'application/pdf' })] },
    });
    expectFlightDraft();

    refreshBudget();
    expectFlightDraft();
    expect(screen.getByRole('button', { name: /alice/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('boarding.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(initial.onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Family flight',
          type: 'flight',
          status: 'confirmed',
          notes: 'Keep this unsaved note',
          confirmation_number: 'FAMILY1',
          day_id: 1,
          end_day_id: 1,
          reservation_time: '2026-10-01T09:10',
          reservation_end_time: '2026-10-01T13:20',
          metadata: expect.objectContaining({ airline: 'Example Air', flight_number: 'EA 123', seat: '4F' }),
          endpoints: [
            expect.objectContaining({ role: 'from', code: 'LHR', local_time: '09:10' }),
            expect.objectContaining({ role: 'to', code: 'JFK', local_time: '13:20' }),
          ],
        })
      )
    );
  });

  it('preserves an edited flight when the same record, selected day and unused prefill refresh', () => {
    const initial = {
      ...props(),
      reservation: buildReservation({ id: 10, type: 'flight', status: 'pending' }),
    };
    const { rerender } = render(<TransportModal {...initial} />);
    fillFlightDraft();
    fireEvent.click(screen.getByRole('button', { name: /alice/i }));

    rerender(
      <TransportModal
        {...initial}
        reservation={{ ...initial.reservation, title: 'Remote title', notes: 'Remote notes' }}
        selectedDayId={2}
        days={[...initial.days]}
        prefill={{ title: 'Unused import', type: 'train' }}
      />
    );
    refreshBudget();
    expectFlightDraft();
    expect(screen.getByRole('button', { name: /alice/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('preserves train stations, times and leg metadata across budget refreshes', async () => {
    const initial = props();
    render(<TransportModal {...initial} />);
    fireEvent.click(screen.getByRole('button', { name: 'Train' }));
    change(titleField(), 'Family train');
    change(screen.getAllByRole('textbox', { name: 'Station or location' })[0], 'Central');
    change(screen.getAllByRole('textbox', { name: 'Station or location' })[1], 'Airport');
    change(screen.getAllByRole('textbox', { name: 'Time' })[0], '10:30');
    change(screen.getAllByRole('textbox', { name: 'Time' })[1], '11:15');
    change(screen.getByPlaceholderText('ICE 123'), 'ICE 456');
    change(screen.getByPlaceholderText('12'), '7');
    change(screen.getByPlaceholderText('42A'), '21C');

    refreshBudget();
    expect(titleField()).toHaveValue('Family train');
    expect(screen.getAllByRole('textbox', { name: 'Station or location' })[0]).toHaveValue('Central');
    expect(screen.getAllByRole('textbox', { name: 'Time' })[1]).toHaveValue('11:15');
    expect(screen.getByPlaceholderText('ICE 123')).toHaveValue('ICE 456');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(initial.onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Family train',
          type: 'train',
          reservation_time: '2026-10-01T10:30',
          reservation_end_time: '2026-10-01T11:15',
          metadata: { train_number: 'ICE 456', platform: '7', seat: '21C' },
          endpoints: [expect.objectContaining({ name: 'Central' }), expect.objectContaining({ name: 'Airport' })],
        })
      )
    );
  });

  it('preserves car endpoints and added stops across budget refreshes', async () => {
    const initial = props();
    render(<TransportModal {...initial} />);
    fireEvent.click(screen.getByRole('button', { name: 'Car' }));
    change(titleField(), 'Family drive');
    fireEvent.click(screen.getByRole('button', { name: /add stop/i }));
    const locations = screen.getAllByRole('textbox', { name: 'Station or location' });
    change(locations[0], 'Pickup');
    change(locations[1], 'Return');
    change(locations[2], 'Lunch stop');
    const times = screen.getAllByRole('textbox', { name: 'Time' });
    change(times[0], '12:00');
    change(times[1], '09:00');
    change(times[2], '17:00');

    refreshBudget();
    expect(titleField()).toHaveValue('Family drive');
    expect(screen.getAllByRole('textbox', { name: 'Station or location' })[2]).toHaveValue('Lunch stop');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(initial.onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'car',
          reservation_time: '2026-10-01T09:00',
          reservation_end_time: '2026-10-01T17:00',
          endpoints: [
            expect.objectContaining({ name: 'Pickup', role: 'from' }),
            expect.objectContaining({ name: 'Lunch stop', role: 'stop', local_time: '12:00' }),
            expect.objectContaining({ name: 'Return', role: 'to' }),
          ],
        })
      )
    );
  });

  it('clears a new draft, travelers and pending files on reopening with the latest selected day', async () => {
    const initial = props();
    const { rerender } = render(<TransportModal {...initial} />);
    fillFlightDraft();
    fireEvent.click(screen.getByRole('button', { name: /alice/i }));
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(['draft'], 'draft.pdf', { type: 'application/pdf' })] },
    });
    rerender(<TransportModal {...initial} selectedDayId={2} />);
    expectFlightDraft();
    rerender(<TransportModal {...initial} isOpen={false} selectedDayId={2} />);
    rerender(<TransportModal {...initial} selectedDayId={2} />);
    expect(titleField()).toHaveValue('');
    expect(notesField()).toHaveValue('');
    expect(screen.getAllByRole('textbox', { name: 'Airport' })[0]).toHaveValue('');
    expect(screen.getAllByRole('textbox', { name: 'Time' })[0]).toHaveValue('');
    expect(screen.getByPlaceholderText('Lufthansa')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Pending' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /alice/i })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('draft.pdf')).not.toBeInTheDocument();

    fillFlightDraft();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(initial.onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          day_id: 2,
          end_day_id: 2,
          reservation_time: '2026-10-02T09:10',
          reservation_end_time: '2026-10-02T13:20',
        })
      )
    );
  });

  it('loads the latest saved record on reopening and resets when selecting another record or create', () => {
    const initial = {
      ...props(),
      reservation: buildReservation({ id: 10, type: 'flight', status: 'pending' }),
    };
    const { rerender } = render(<TransportModal {...initial} />);
    fillFlightDraft();
    const refreshed = { ...initial.reservation, title: 'Latest flight', notes: 'Latest saved note' };
    rerender(<TransportModal {...initial} reservation={refreshed} isOpen={false} />);
    rerender(<TransportModal {...initial} reservation={refreshed} />);
    expect(titleField()).toHaveValue('Latest flight');
    expect(notesField()).toHaveValue('Latest saved note');
    expect(screen.getByRole('button', { name: 'Pending' })).toBeInTheDocument();

    const next = buildReservation({
      id: 11,
      type: 'train',
      title: 'Next train',
      status: 'pending',
      metadata: JSON.stringify({ train_number: 'ICE 999', platform: '5' }),
    });
    rerender(<TransportModal {...initial} reservation={next} />);
    expect(titleField()).toHaveValue('Next train');
    expect(screen.getByPlaceholderText('ICE 123')).toHaveValue('ICE 999');
    expect(screen.getByPlaceholderText('12')).toHaveValue('5');

    rerender(<TransportModal {...initial} reservation={null} />);
    expect(titleField()).toHaveValue('');
    expect(screen.getAllByRole('textbox', { name: 'Airport' })[0]).toHaveValue('');
    expect(screen.getByPlaceholderText('Lufthansa')).toHaveValue('');
  });

  it('preserves an import draft through refreshes and seeds the next import item and source files', () => {
    const prefill: BookingReviewDraft = {
      title: 'Imported flight',
      type: 'flight',
      status: 'pending',
      _sourceFiles: [new File(['first'], 'first.pdf', { type: 'application/pdf' })],
    };
    const initial = { ...props(), prefill };
    const { rerender } = render(<TransportModal {...initial} />);
    fillFlightDraft();
    refreshBudget();
    rerender(<TransportModal {...initial} days={[...initial.days]} selectedDayId={2} />);
    expectFlightDraft();
    expect(screen.getByText('first.pdf')).toBeInTheDocument();

    const next: BookingReviewDraft = {
      title: 'Imported train',
      type: 'train',
      status: 'pending',
      notes: 'Second item',
      metadata: { train_number: 'ICE 789' },
      _sourceFiles: [new File(['second'], 'second.pdf', { type: 'application/pdf' })],
    };
    rerender(<TransportModal {...initial} prefill={next} />);
    expect(titleField()).toHaveValue('Imported train');
    expect(notesField()).toHaveValue('Second item');
    expect(screen.getByPlaceholderText('ICE 123')).toHaveValue('ICE 789');
    expect(screen.getByRole('button', { name: 'Pending' })).toBeInTheDocument();
    expect(screen.queryByText('first.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('second.pdf')).toBeInTheDocument();
  });
});
