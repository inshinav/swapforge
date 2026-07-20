import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  document.cookie = 'sf_csrf=; Max-Age=0; Path=/';
});
