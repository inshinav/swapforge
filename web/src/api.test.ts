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
    fetchMock.mockRestore();
  });

  it('requests public pricing and payment methods for the owner user-preview mode', async () => {
    window.history.replaceState({}, '', '/swapforge/#swap');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    await api.estimate('project-1', { removeText: true, enhanceFigure: false, wish: 'test wish' }, true);
    await api.billingMethods(true);

    const estimateUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(estimateUrl.pathname).toBe('/swapforge/api/projects/project-1/estimate');
    expect(estimateUrl.searchParams.get('preview')).toBe('user');
    expect(estimateUrl.searchParams.get('wish')).toBe('test wish');
    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      `${window.location.origin}/swapforge/api/billing/packs?preview=user`,
    );
    fetchMock.mockRestore();
  });
});
