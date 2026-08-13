import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import { resolveMapsLink } from "./mapsLink";

/** A 3xx redirect Response pointing at `location`. */
function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

function okResponse(): Response {
  return new Response("<html></html>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("resolveMapsLink long-form parsing (no network)", () => {
  it("parses a /place/ URL with an @lat,lon viewport", async () => {
    const out = await resolveMapsLink(
      "https://www.google.com/maps/place/Rud-Alpe+Gastronomie/@47.2011,10.1166,17z",
    );
    expect(out).toEqual({
      kind: "ok",
      place: "Rud-Alpe Gastronomie",
      coords: { lat: 47.2011, lon: 10.1166 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers the !3d/!4d pin over the @lat,lon viewport center", async () => {
    const out = await resolveMapsLink(
      "https://www.google.com/maps/place/Lech/@47.2,10.1,15z/data=!4m6!3m5!1s0x0!3d47.20635!4d10.14355",
    );
    expect(out).toEqual({
      kind: "ok",
      place: "Lech",
      coords: { lat: 47.20635, lon: 10.14355 },
    });
  });

  it("parses a ?q=lat,lon URL and falls back to formatted coords for the name", async () => {
    const out = await resolveMapsLink("https://maps.google.com/?q=47.2011,10.1166");
    expect(out).toEqual({
      kind: "ok",
      place: "47.20110,10.11660",
      coords: { lat: 47.2011, lon: 10.1166 },
    });
  });

  it("parses the api=1 &query=lat,lon form", async () => {
    const out = await resolveMapsLink(
      "https://www.google.com/maps/search/?api=1&query=-33.8688,151.2093",
    );
    expect(out).toEqual({
      kind: "ok",
      place: "-33.86880,151.20930",
      coords: { lat: -33.8688, lon: 151.2093 },
    });
  });

  it("parses a country-TLD Maps host", async () => {
    const out = await resolveMapsLink("https://www.google.de/maps/@48.1372,11.5756,15z");
    expect(out).toEqual({
      kind: "ok",
      place: "48.13720,11.57560",
      coords: { lat: 48.1372, lon: 11.5756 },
    });
  });

  it("decodes percent-encoded place names", async () => {
    const out = await resolveMapsLink(
      "https://www.google.com/maps/place/Caf%C3%A9+Sperl/@48.1979,16.3616,17z",
    );
    expect(out).toMatchObject({ kind: "ok", place: "Café Sperl" });
  });

  it("rejects a non-Maps URL", async () => {
    expect(await resolveMapsLink("https://example.com")).toEqual({ kind: "invalidLink" });
    expect(await resolveMapsLink("https://evil.com/maps/@47.2,10.1")).toEqual({
      kind: "invalidLink",
    });
  });

  it("rejects attacker domains that merely START with a google. label", async () => {
    // The host check must match the TLD exactly, not prefix-match: a dotted
    // wildcard would hand every one of these a valid Maps parse.
    for (const host of [
      "google.evil.com",
      "www.google.attacker.com",
      "maps.google.attacker.com",
      "google.com.evil.net",
      "google.evil.io", // 2-char TLD — the case a naive ccTLD regex still lets through
      "google.evil.co",
      "notgoogle.com",
      "googleXcom",
    ]) {
      expect(
        await resolveMapsLink(`https://${host}/maps/place/Pwned/@47.2011,10.1166,17z`),
      ).toEqual({ kind: "invalidLink" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still accepts the real Google country TLDs", async () => {
    for (const host of ["google.com", "www.google.de", "maps.google.fr", "www.google.co.uk"]) {
      expect(
        await resolveMapsLink(`https://${host}/maps/place/Lech/@47.2063,10.1435,17z`),
      ).toMatchObject({ kind: "ok", coords: { lat: 47.2063, lon: 10.1435 } });
    }
  });

  it("rejects a directions URL instead of guessing the route midpoint", async () => {
    // @48.4,3.9 here is the viewport center between Paris and Lyon — neither
    // endpoint. Saving that silently would be worse than failing.
    const out = await resolveMapsLink(
      "https://www.google.com/maps/dir/Paris,+France/Lyon,+France/@46.4033,3.9026,7z/data=!3m1!4b1",
    );
    expect(out).toEqual({ kind: "invalidLink" });
  });

  it("ignores the viewport center on non-place Maps URLs", async () => {
    expect(await resolveMapsLink("https://www.google.com/maps/timeline/@47.2,10.1,15z")).toEqual({
      kind: "invalidLink",
    });
  });

  it("rejects a non-http(s) or malformed input", async () => {
    expect(await resolveMapsLink("geo:47.2,10.1")).toEqual({ kind: "invalidLink" });
    expect(await resolveMapsLink("not a url")).toEqual({ kind: "invalidLink" });
    expect(await resolveMapsLink("")).toEqual({ kind: "invalidLink" });
  });

  it("rejects a Maps URL carrying no coordinates", async () => {
    expect(await resolveMapsLink("https://www.google.com/maps/place/Somewhere")).toEqual({
      kind: "invalidLink",
    });
  });

  it("rejects out-of-range coordinates", async () => {
    expect(await resolveMapsLink("https://www.google.com/maps/@999,10.1,15z")).toEqual({
      kind: "invalidLink",
    });
  });
});

describe("resolveMapsLink short-link resolution", () => {
  it("follows a short link to its long-form URL and parses that", async () => {
    fetchMock.mockResolvedValueOnce(
      redirectResponse("https://www.google.com/maps/place/Rud-Alpe/@47.2011,10.1166,17z"),
    );
    fetchMock.mockResolvedValueOnce(okResponse());

    const out = await resolveMapsLink("https://maps.app.goo.gl/AbCdEf123");

    expect(out).toEqual({
      kind: "ok",
      place: "Rud-Alpe",
      coords: { lat: 47.2011, lon: 10.1166 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("follows a legacy goo.gl/maps short link", async () => {
    fetchMock.mockResolvedValueOnce(
      redirectResponse("https://www.google.com/maps/@47.2011,10.1166,17z"),
    );
    fetchMock.mockResolvedValueOnce(okResponse());

    expect(await resolveMapsLink("https://goo.gl/maps/AbCdEf")).toMatchObject({ kind: "ok" });
  });

  it("fires the SSRF guard when a short link redirects to an internal host", async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse("http://169.254.169.254/latest/meta-data/"));

    const out = await resolveMapsLink("https://maps.app.goo.gl/AbCdEf123");

    expect(out).toEqual({ kind: "error", message: "Could not resolve the Maps link." });
    // The blocked target was never fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fires the SSRF guard for a redirect to localhost", async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse("http://localhost:8080/admin"));
    expect(await resolveMapsLink("https://maps.app.goo.gl/AbCdEf123")).toEqual({
      kind: "error",
      message: "Could not resolve the Maps link.",
    });
  });

  it("collapses a network failure to an error outcome", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await resolveMapsLink("https://maps.app.goo.gl/AbCdEf123")).toEqual({
      kind: "error",
      message: "Could not resolve the Maps link.",
    });
  });

  it("reports a resolution failure when a short link is dead (404)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    expect(await resolveMapsLink("https://maps.app.goo.gl/AbCdEf123")).toEqual({
      kind: "error",
      message: "Could not resolve the Maps link.",
    });
  });

  it("rejects a short link redirecting to a google-prefixed attacker host", async () => {
    fetchMock.mockResolvedValueOnce(
      redirectResponse("https://google.evil.com/maps/place/Pwned/@1,2,17z"),
    );
    fetchMock.mockResolvedValueOnce(okResponse());
    expect(await resolveMapsLink("https://maps.app.goo.gl/AbCdEf123")).toEqual({
      kind: "invalidLink",
    });
  });

  it("returns invalidLink when a short link lands off Google", async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse("https://example.com/@47.2,10.1"));
    fetchMock.mockResolvedValueOnce(okResponse());
    expect(await resolveMapsLink("https://maps.app.goo.gl/AbCdEf123")).toEqual({
      kind: "invalidLink",
    });
  });
});
