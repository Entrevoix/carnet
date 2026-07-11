import { describe, expect, it, vi, beforeEach } from "vitest";
import { ocrBusinessCard } from "./ocr";

describe("ocrBusinessCard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("posts to /v1/ocr with a Mistral-shaped document.image_url body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ pages: [{ markdown: "ACME Corp" }] }), {
        status: 200,
      }),
    );

    await ocrBusinessCard(
      "https://omniroute.example.com",
      "sk-test-key",
      "YmFzZTY0ZGF0YQ==",
      "image/jpeg",
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://omniroute.example.com/v1/ocr",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer sk-test-key",
        }),
      }),
    );
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]?.body as string);
    expect(body).toEqual({
      document: { image_url: "data:image/jpeg;base64,YmFzZTY0ZGF0YQ==" },
    });
  });

  it("omits the Authorization header when no API key is configured", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ pages: [{ markdown: "ok" }] }), {
        status: 200,
      }),
    );

    await ocrBusinessCard("https://omniroute.example.com", "", "abc", "image/jpeg");

    const call = vi.mocked(fetch).mock.calls[0];
    const headers = call[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("trims trailing slashes from the base URL", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ pages: [{ markdown: "ok" }] }), {
        status: 200,
      }),
    );

    await ocrBusinessCard("https://omniroute.example.com///", "k", "abc", "image/jpeg");

    expect(fetch).toHaveBeenCalledWith(
      "https://omniroute.example.com/v1/ocr",
      expect.anything(),
    );
  });

  it("throws when the OmniRoute URL is not configured", async () => {
    await expect(ocrBusinessCard("  ", "k", "abc", "image/jpeg")).rejects.toThrow(
      "OmniRoute URL not configured",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("bad", { status: 400, statusText: "Bad Request" }),
    );

    await expect(
      ocrBusinessCard("https://omniroute.example.com", "k", "abc", "image/jpeg"),
    ).rejects.toThrow("OmniRoute returned HTTP 400 Bad Request");
  });

  it("throws when the response has no pages with text", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ pages: [] }), { status: 200 }),
    );

    await expect(
      ocrBusinessCard("https://omniroute.example.com", "k", "abc", "image/jpeg"),
    ).rejects.toThrow("OmniRoute response contained no OCR text");
  });

  it("throws when pages exist but all markdown is blank", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ pages: [{ markdown: "" }, {}] }), {
        status: 200,
      }),
    );

    await expect(
      ocrBusinessCard("https://omniroute.example.com", "k", "abc", "image/jpeg"),
    ).rejects.toThrow("OmniRoute response contained no OCR text");
  });

  it("joins multiple pages' markdown in order", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          pages: [{ markdown: "Page one" }, { markdown: "Page two" }],
        }),
        { status: 200 },
      ),
    );

    const result = await ocrBusinessCard(
      "https://omniroute.example.com",
      "k",
      "abc",
      "image/jpeg",
    );

    expect(result).toEqual({ text: "Page one\n\nPage two" });
  });

  it("returns the extracted text on success", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ pages: [{ markdown: "Jane Doe, CEO" }] }), {
        status: 200,
      }),
    );

    const result = await ocrBusinessCard(
      "https://omniroute.example.com",
      "k",
      "abc",
      "image/jpeg",
    );

    expect(result).toEqual({ text: "Jane Doe, CEO" });
  });
});
