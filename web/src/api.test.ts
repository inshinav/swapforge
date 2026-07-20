import { describe, expect, it, vi } from 'vitest';
import { api, csrfHeader, csrfToken } from './api';

describe('web API foundation', () => {
  it('reads and decodes the double-submit CSRF cookie', () => {
    document.cookie = 'sf_csrf=token%2Bwith%2Fsymbols; Path=/';
    expect(csrfToken()).toBe('token+with/symbols');
    expect(csrfHeader()).toEqual({ 'x-sf-csrf': 'token+with/symbols' });
  });

  it('builds API requests from origin without inheriting URL credentials', async () => {
    window.history.replaceState({}, '', '/swapforge/#billing');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, version: 'test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await api.health();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${window.location.origin}/swapforge/api/health`);
  });
});
