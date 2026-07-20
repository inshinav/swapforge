import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import Login from './Login';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Login recovery', () => {
  it('shows a retry after health failure and recovers on the next request', async () => {
    const health = vi
      .spyOn(api, 'health')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, version: 'test', tgBot: null, devAuth: false });
    const root = createRoot(document.body.appendChild(document.createElement('div')));

    await act(async () => {
      root.render(<Login onAuthed={() => undefined} />);
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('Не удалось связаться');
    const retry = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Повторить'))!;
    await act(async () => {
      retry.click();
      await Promise.resolve();
    });
    expect(health).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('Вход не настроен');
    await act(async () => root.unmount());
  });
});
