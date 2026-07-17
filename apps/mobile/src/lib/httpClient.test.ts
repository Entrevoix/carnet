import { describe, expect, it } from "vitest";

import {
  HttpError,
  parseErrorBody,
  sanitizeErrorMessage,
  withTimeout,
} from "./httpClient";

describe("HttpError", () => {
  it("carries status and defaults notConfigured to false", () => {
    const e = new HttpError("boom", 503);
    expect(e.status).toBe(503);
    expect(e.notConfigured).toBe(false);
    expect(e).toBeInstanceOf(Error);
  });

  it("marks notConfigured when opted in", () => {
    expect(new HttpError("no url", 0, { notConfigured: true }).notConfigured).toBe(
      true,
    );
  });
});

describe("sanitizeErrorMessage", () => {
  it("redacts Bearer tokens and Authorization headers", () => {
    expect(sanitizeErrorMessage("denied for Bearer sk-live.abc/= end")).toBe(
      "denied for Bearer [redacted] end",
    );
    expect(sanitizeErrorMessage("sent Authorization: xyz123; retry")).toBe(
      "sent Authorization: [redacted]; retry",
    );
  });

  it("passes clean strings through", () => {
    expect(sanitizeErrorMessage("HTTP 502 upstream")).toBe("HTTP 502 upstream");
  });
});

describe("parseErrorBody", () => {
  const res = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status });

  it("reads the OpenAI shape {error: {message}}", async () => {
    await expect(
      parseErrorBody(res(400, { error: { message: "bad model" } })),
    ).resolves.toBe("HTTP 400: bad model");
  });

  it("reads flat {error} and {message} string shapes", async () => {
    await expect(parseErrorBody(res(401, { error: "no auth" }))).resolves.toBe(
      "HTTP 401: no auth",
    );
    await expect(
      parseErrorBody(res(422, { message: "unprocessable" })),
    ).resolves.toBe("HTTP 422: unprocessable");
  });

  it("sanitizes the parsed message", async () => {
    await expect(
      parseErrorBody(res(403, { error: "rejected Bearer sk-oops" })),
    ).resolves.toBe("HTTP 403: rejected Bearer [redacted]");
  });

  it("falls back to the bare status on a non-JSON body", async () => {
    await expect(
      parseErrorBody(new Response("<html>gateway</html>", { status: 502 })),
    ).resolves.toBe("HTTP 502");
  });
});

describe("withTimeout", () => {
  it("passes through a fast success", async () => {
    await expect(
      withTimeout(1000, () => new Error("timeout"), async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("rejects with the client-supplied error and aborts the signal on timeout", async () => {
    let aborted = false;
    await expect(
      withTimeout(
        20,
        (ms) => new HttpError(`timed out after ${ms}ms`, 0),
        (signal) =>
          // Hangs forever (a stuck TCP connect); only records the abort.
          // (A run() that REJECTS on abort races the timeout error — both
          // are status-0 outcomes and the real clients wrap that rejection
          // inside run(), so the winner is caller-equivalent.)
          new Promise<never>(() => {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
          }),
      ),
    ).rejects.toThrow("timed out after 20ms");
    expect(aborted).toBe(true);
  });

  it("propagates the run()'s own rejection unchanged", async () => {
    await expect(
      withTimeout(1000, () => new Error("timeout"), async () => {
        throw new HttpError("HTTP 500", 500);
      }),
    ).rejects.toThrow("HTTP 500");
  });
});
