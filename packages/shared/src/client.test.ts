import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HmacSHA256 from "crypto-js/hmac-sha256";
import EncHex from "crypto-js/enc-hex";

import { NavettedClient } from "./client.js";

/**
 * Minimal in-process WebSocket stub that drives the client through the v2
 * challenge-response handshake and lets tests replay daemon-side events.
 *
 * We install it on `globalThis.WebSocket` for the duration of each test so
 * the client constructor's `new WebSocket(url)` picks up our mock.
 */
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = 0;
  onopen: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  receive(json: object): void {
    this.onmessage?.({ data: JSON.stringify(json) });
  }
}

const TOKEN = "supersecret";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function connectAndAuth(client: NavettedClient): Promise<MockWebSocket> {
  client.connect();
  await flush();
  const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  expect(sock).toBeDefined();
  // Client should have sent hello v2.
  const hello = JSON.parse(sock.sent[0]) as Record<string, unknown>;
  expect(hello.type).toBe("hello");
  expect(hello.version).toBe(2);
  // Server replies with a challenge.
  const nonce = "deadbeef";
  sock.receive({ type: "challenge", nonce });
  await flush();
  // Client should have computed HMAC.
  const expectedHmac = HmacSHA256(nonce, TOKEN).toString(EncHex);
  const challengeResponse = JSON.parse(sock.sent[1]) as Record<string, unknown>;
  expect(challengeResponse.type).toBe("challenge_response");
  expect(challengeResponse.hmac).toBe(expectedHmac);
  // Server welcomes.
  sock.receive({ type: "welcome", client_id: "cid" });
  await flush();
  expect(client.getStatus()).toBe("connected");
  return sock;
}

describe("NavettedClient", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket =
      MockWebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("performs hello v2 handshake with HMAC challenge response", async () => {
    const client = new NavettedClient({
      url: "ws://x",
      token: TOKEN,
      clientId: "cid",
    });
    await connectAndAuth(client);
    client.disconnect();
  });

  it("correlates capture responses by request_id", async () => {
    const client = new NavettedClient({
      url: "ws://x",
      token: TOKEN,
      clientId: "cid",
    });
    const sock = await connectAndAuth(client);

    const promise = client.captureIdea({ text: "hello world" });
    await flush();
    // Find the capture envelope in the sent log.
    const sent = sock.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .find((m) => m.type === "capture/idea");
    expect(sent).toBeDefined();
    const requestId = sent!.request_id as string;
    expect(typeof requestId).toBe("string");
    expect(requestId.length).toBeGreaterThan(0);

    sock.receive({
      type: "capture_response",
      request_id: requestId,
      status: "ok",
      filepath: "/tmp/idea.md",
      preview_markdown: "# Hello",
    });

    const result = await promise;
    expect(result.status).toBe("ok");
    expect(result.filepath).toBe("/tmp/idea.md");
    expect(result.preview_markdown).toBe("# Hello");
    client.disconnect();
  });

  it("ignores capture responses with unknown request_id", async () => {
    const client = new NavettedClient({
      url: "ws://x",
      token: TOKEN,
      clientId: "cid",
    });
    const sock = await connectAndAuth(client);

    const promise = client.captureIdea({ text: "hi" });
    await flush();

    // Reply with the wrong request_id — the promise must NOT resolve.
    sock.receive({
      type: "capture_response",
      request_id: "wrong-id",
      status: "ok",
      filepath: "/tmp/whatever.md",
    });

    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false);

    // Now resolve correctly so the test cleans up.
    const sent = sock.sent.find((s) => s.includes('"capture/idea"'))!;
    const requestId = (JSON.parse(sent) as Record<string, unknown>)
      .request_id as string;
    sock.receive({
      type: "capture_response",
      request_id: requestId,
      status: "ok",
    });
    await promise;
    client.disconnect();
  });

  it("ping resolves with rttMs and serverTs", async () => {
    const client = new NavettedClient({
      url: "ws://x",
      token: TOKEN,
      clientId: "cid",
    });
    const sock = await connectAndAuth(client);

    const promise = client.ping();
    await flush();
    const sent = sock.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .find((m) => m.type === "ping");
    expect(sent).toBeDefined();
    sock.receive({
      type: "pong",
      request_id: sent!.request_id,
      server_ts: 1700000000.5,
    });
    const result = await promise;
    expect(result.rttMs).toBeGreaterThanOrEqual(0);
    expect(result.serverTs).toBe(1700000000.5);
    client.disconnect();
  });

  it("promoteIdea sends the right envelope", async () => {
    const client = new NavettedClient({
      url: "ws://x",
      token: TOKEN,
      clientId: "cid",
    });
    const sock = await connectAndAuth(client);

    const promise = client.promoteIdea("/tmp/i.md", "developing");
    await flush();
    const sent = sock.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .find((m) => m.type === "capture/idea/promote");
    expect(sent).toBeDefined();
    expect(sent!.filepath).toBe("/tmp/i.md");
    expect(sent!.status).toBe("developing");

    sock.receive({
      type: "capture_response",
      request_id: sent!.request_id,
      status: "ok",
      filepath: "/tmp/i.md",
      preview_markdown: "---\nstatus: developing\n---\n# T\n",
    });
    const result = await promise;
    expect(result.status).toBe("ok");
    client.disconnect();
  });

  it("rejects pending requests when the connection closes", async () => {
    const client = new NavettedClient({
      url: "ws://x",
      token: TOKEN,
      clientId: "cid",
    });
    const sock = await connectAndAuth(client);

    const promise = client.captureIdea({ text: "x" });
    await flush();
    sock.close();

    await expect(promise).rejects.toThrow();
  });
});
