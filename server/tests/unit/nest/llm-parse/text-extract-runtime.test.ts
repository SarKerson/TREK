import { extractText, isPdf, isTextLike } from '../../../../src/nest/llm-parse/text-extract';

import { describe, expect, it, vi } from 'vitest';

const { loadPdf } = vi.hoisted(() => ({ loadPdf: vi.fn() }));
vi.mock('pdf-parse', () => {
  loadPdf();
  throw new Error('DOMMatrix is not defined: private installation path');
});

describe('optional PDF runtime isolation', () => {
  it('imports classification and text extraction without loading PDF dependencies', async () => {
    expect(isPdf('booking.PDF')).toBe(true);
    expect(isTextLike('booking.html')).toBe(true);
    expect(await extractText(Buffer.from('<p>Hotel reservation</p>'), 'booking.html')).toBe('Hotel reservation');
    expect(await extractText(Buffer.from('Booking 123'), 'booking.txt')).toBe('Booking 123');
    expect(loadPdf).not.toHaveBeenCalled();
  });

  it('fails only the PDF request with a bounded message when native dependencies are missing', async () => {
    await expect(extractText(Buffer.from('%PDF-1.4'), 'booking.pdf')).rejects.toMatchObject({
      message: 'PDF text extraction is unavailable on this server',
    });
    expect(loadPdf).toHaveBeenCalledTimes(1);
    expect(await extractText(Buffer.from('Still available'), 'booking.txt')).toBe('Still available');
  });
});
