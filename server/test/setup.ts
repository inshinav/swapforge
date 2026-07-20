import { afterEach, vi } from 'vitest';

const blockedFetch = vi.fn(async (input: string | URL | Request) => {
  const target = input instanceof Request ? input.url : String(input);
  throw new Error(`Unexpected external network request in test: ${target}`);
});

// Setup files run before each test module is evaluated, so clients that capture `fetch`
// at module initialization also receive the fail-closed implementation.
vi.stubGlobal('fetch', blockedFetch as unknown as typeof fetch);

afterEach(() => {
  blockedFetch.mockClear();
});
