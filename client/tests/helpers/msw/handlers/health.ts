import { http, HttpResponse } from 'msw';

/** Default persistent-server capabilities; direct-upload tests opt in explicitly. */
export const healthHandlers = [
  http.get('/api/health/features', () => HttpResponse.json({ bookingImport: false, aiParsing: false })),
];
