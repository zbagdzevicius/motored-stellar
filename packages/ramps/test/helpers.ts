import type { HttpClient } from "../src/ports.js";

/** One recorded request. Headers are kept so tests can assert on them. */
export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A fetch mock that records every request and answers from a queue of
 * `{ status, body }` responses (default 200 `{}`).
 */
export function mockHttp(responses: Array<{ status?: number; body?: unknown }> = []) {
  const calls: Recorded[] = [];
  const queue = [...responses];
  const http: HttpClient = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: { ...init.headers },
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    const next = queue.shift() ?? {};
    const status = next.status ?? 200;
    const text = next.body === undefined ? "" : JSON.stringify(next.body);
    return { status, ok: status >= 200 && status < 300, text: async () => text };
  };
  return { http, calls };
}

/** A sandbox-shaped fake key. Not a real credential. */
export const FAKE_SANDBOX_KEY = "sk-test-fake-key-for-unit-tests";
