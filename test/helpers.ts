import { vi } from "vitest";

/** A fetch stand-in: each call is answered by `respond(url, init)`. */
export function stubFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
