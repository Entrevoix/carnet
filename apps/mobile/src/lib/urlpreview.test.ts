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

beforeEach(() => {
  fetchMock.mockReset();
});

describe("fetchUrlPreview", () => {
  it("extracts og:* fields and returns structured preview", async () => {
    const html = `
      <html><head>
        <title>Fallback Title</title>
        <meta property="og:title" content="A Real Article">
        <meta property="og:description" content="The summary of the article.">
        <meta property="og:site_name" content="Example News">
      </head><body><p>First paragraph.</p></body></html>
    `;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/article");

    expect(result).not.toBeNull();
    expect(result!.title).toBe("A Real Article");
    expect(result!.description).toBe("The summary of the article.");
    expect(result!.siteName).toBe("Example News");
    expect(result!.contentType).toMatch(/text\/html/);
  });

  it("falls through to <title> and meta description when og:* missing", async () => {
    const html = `
      <html><head>
        <title>Plain Title</title>
        <meta name="description" content="Plain description.">
      </head></html>
    `;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/plain");

    expect(result).not.toBeNull();
    expect(result!.title).toBe("Plain Title");
    expect(result!.description).toBe("Plain description.");
    expect(result!.siteName).toBe("example.com");
  });

  it("decodes HTML entities in extracted fields", async () => {
    const html = `
      <html><head>
        <title>Q&amp;A: What&#39;s next?</title>
        <meta name="description" content="Costs &lt; 5 &amp; rising">
      </head></html>
    `;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/x");

    expect(result!.title).toBe("Q&A: What's next?");
    expect(result!.description).toBe("Costs < 5 & rising");
  });

  it("truncates very large bodies but still extracts from the <head>", async () => {
    // 300 KB of trailing junk — title sits in the first KB.
    const junk = "<div>x</div>".repeat(40_000);
    const html = `<html><head><title>Buried Title</title></head><body>${junk}</body></html>`;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/big");

    expect(result!.title).toBe("Buried Title");
  });

  it("returns null on non-200 response", async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse("<html></html>", 404));
    expect(await fetchUrlPreview("https://example.com/missing")).toBeNull();
  });

  it("returns null on non-HTML content-type", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"k":"v"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await fetchUrlPreview("https://example.com/api")).toBeNull();
  });

  it("returns null when fetch rejects (network error)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await fetchUrlPreview("https://example.com/offline")).toBeNull();
  });

  it("returns null on AbortError (timeout)", async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    expect(await fetchUrlPreview("https://example.com/slow")).toBeNull();
  });

  it("returns null for invalid URL without fetching", async () => {
    expect(await fetchUrlPreview("not a url")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null for non-http(s) schemes without fetching", async () => {
    expect(await fetchUrlPreview("file:///etc/passwd")).toBeNull();
    expect(await fetchUrlPreview("javascript:alert(1)")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when both title and description are absent", async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse("<html><head></head><body></body></html>"),
    );
    expect(await fetchUrlPreview("https://example.com/empty")).toBeNull();
  });

  it("uses first <p> as description fallback", async () => {
    const html = `
      <html><head><title>Only Title</title></head>
      <body><p>The opening <strong>paragraph</strong> here.</p></body></html>
    `;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/p");

    expect(result!.title).toBe("Only Title");
    expect(result!.description).toBe("The opening paragraph here.");
  });

  it("sends a Mozilla-compatible User-Agent", async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse("<html><head><title>X</title></head></html>"),
    );
    await fetchUrlPreview("https://example.com/ua");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const ua = (init.headers as Record<string, string>)["User-Agent"];
    expect(ua).toMatch(/Mozilla/);
    expect(ua).toMatch(/carnet/);
  });

  it("handles meta tags with content-first attribute order", async () => {
    const html = `
      <html><head>
        <meta content="Reordered Title" property="og:title">
        <meta content="Reordered Desc" name="description">
      </head></html>
    `;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/order");

    expect(result!.title).toBe("Reordered Title");
    expect(result!.description).toBe("Reordered Desc");
  });

  it("trims fields longer than 500 characters", async () => {
    const long = "A".repeat(1000);
    const html = `<html><head><meta property="og:title" content="${long}"><title>x</title></head></html>`;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/long");

    expect(result!.title.length).toBeLessThanOrEqual(500);
  });

  it("does not throw on numeric entities above U+10FFFF", async () => {
    // &#1114112; is exactly one beyond the max code point —
    // String.fromCodePoint would throw RangeError without the guard.
    const html = `<html><head><title>safe &#1114112; title</title></head></html>`;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/oob");

    expect(result).not.toBeNull();
    // The entity decodes to "" and clean() collapses the surrounding
    // whitespace to a single space.
    expect(result!.title).toBe("safe title");
  });

  it("rejects meta tags with mismatched quote pairs", async () => {
    // Opening `"` paired with closing `'` — unbalanced markup.
    const html = `<html><head>
      <meta property="og:title" content="mismatch'>
      <title>Fallback OK</title>
    </head></html>`;
    fetchMock.mockResolvedValueOnce(htmlResponse(html));

    const result = await fetchUrlPreview("https://example.com/quotes");

    // og:title is unbalanced, so the parser falls through to <title>.
    expect(result!.title).toBe("Fallback OK");
  });

  it("blocks loopback hosts without fetching (SSRF guard)", async () => {
    expect(await fetchUrlPreview("http://localhost:8081/")).toBeNull();
    expect(await fetchUrlPreview("http://127.0.0.1/admin")).toBeNull();
    expect(await fetchUrlPreview("http://127.0.0.5/")).toBeNull();
    expect(await fetchUrlPreview("http://0.0.0.0/")).toBeNull();
    expect(await fetchUrlPreview("http://[::1]/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks cloud metadata service without fetching (SSRF guard)", async () => {
    expect(
      await fetchUrlPreview("http://169.254.169.254/latest/meta-data/"),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Non-canonical IP encodings (#68). RN's URL does no canonicalization, so a
  // string-literal deny-list is bypassed by decimal/hex/octal/short forms even
  // though the native fetch layer resolves them to the real loopback / metadata
  // address. The guard now normalizes to a numeric range before comparing.
  it("blocks decimal-encoded loopback (2130706433 = 127.0.0.1)", async () => {
    expect(await fetchUrlPreview("http://2130706433/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks hex-encoded loopback (0x7f000001 = 127.0.0.1)", async () => {
    expect(await fetchUrlPreview("http://0x7f000001/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks octal-encoded loopback (0177.0.0.1 = 127.0.0.1)", async () => {
    expect(await fetchUrlPreview("http://0177.0.0.1/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks short-form loopback (127.1 = 127.0.0.1)", async () => {
    expect(await fetchUrlPreview("http://127.1/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks decimal-encoded cloud metadata (2852039166 = 169.254.169.254)", async () => {
    expect(await fetchUrlPreview("http://2852039166/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks IPv6 loopback [::1]", async () => {
    expect(await fetchUrlPreview("http://[::1]/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks IPv4-mapped IPv6 loopback [::ffff:127.0.0.1]", async () => {
    expect(await fetchUrlPreview("http://[::ffff:127.0.0.1]/")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not block a genuine public HTTPS host (no false positive)", async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse("<html><head><title>Public</title></head></html>"),
    );
    const result = await fetchUrlPreview("https://example.com/");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Public");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows general private RFC1918 ranges (self-hosted is legitimate)", async () => {
    fetchMock.mockResolvedValueOnce(
      htmlResponse("<html><head><title>Internal Wiki</title></head></html>"),
    );
    const result = await fetchUrlPreview("http://192.168.1.10/wiki");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Internal Wiki");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
