import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import { fetchUrlPreview } from "./urlpreview";

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** A 3xx redirect Response pointing at `location`. */
function redirectResponse(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: { Location: location },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

// M2 — SSRF via redirect. The fetch follows redirects MANUALLY and re-runs the
// SSRF host guard on every hop, so a public page cannot 3xx-bounce the GET into
// cloud metadata or a LAN host.
describe("fetchUrlPreview redirect hardening", () => {
  it("blocks a redirect to cloud metadata (169.254.169.254) after one hop", async () => {
    fetchMock.mockResolvedValueOnce(
      redirectResponse("http://169.254.169.254/latest/meta-data/"),
    );

    const result = await fetchUrlPreview("https://public.example.com/start");

    expect(result).toBeNull();
    // The initial request fired; the redirect target was NEVER fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect to a decimal-encoded metadata address (#68)", async () => {
    // 2852039166 == 169.254.169.254 — the redirect hop must normalize the
    // non-canonical encoding, not just string-match the dotted form.
    fetchMock.mockResolvedValueOnce(redirectResponse("http://2852039166/"));

    const result = await fetchUrlPreview("https://public.example.com/start");

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect to localhost", async () => {
    fetchMock.mockResolvedValueOnce(
      redirectResponse("http://localhost/internal"),
    );

    const result = await fetchUrlPreview("https://public.example.com/start");

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to a legitimate HTTPS URL", async () => {
    const html = `<html><head><title>Redirected Page</title></head></html>`;
    fetchMock
      .mockResolvedValueOnce(redirectResponse("https://final.example.com/page"))
      .mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://public.example.com/start");

    expect(result).not.toBeNull();
    expect(result!.title).toBe("Redirected Page");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second request went to the redirect target.
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://final.example.com/page");
  });

  it("aborts a chain of more than 5 redirects (loop / DoS guard)", async () => {
    // Every request 302s onward to another allowed host, forever.
    fetchMock.mockResolvedValue(
      redirectResponse("https://hop.example.com/next"),
    );

    const result = await fetchUrlPreview("https://public.example.com/start");

    expect(result).toBeNull();
    // Initial request + 5 followed redirects = 6 fetches, then it aborts.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
