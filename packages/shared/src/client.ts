/**
 * NavettedClient — typed WebSocket client for the capture/* RPCs.
 *
 * Speaks navetted's hello v2 challenge-response handshake (HMAC-SHA256 of the
 * server's nonce, keyed by the shared token). After welcome, every capture
 * request carries a uuid `request_id` and a Promise is resolved when the
 * matching `capture_response` event arrives.
 */

import HmacSHA256 from "crypto-js/hmac-sha256";
import EncHex from "crypto-js/enc-hex";
import { v4 as uuidv4 } from "uuid";

import type {
  CaptureIdeaPayload,
  CaptureJournalPayload,
  CapturePersonPayload,
  CaptureResponse,
  PromoteIdeaPayload,
} from "./messages.js";
import type { IdeaStatus } from "./types.js";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "error";

export interface NavettedClientOptions {
  url: string;
  token: string;
  clientId: string;
  /** Called whenever the connection status changes. */
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  /** Initial reconnect delay in ms. Doubles up to maxReconnectDelay. */
  initialReconnectDelay?: number;
  /** Cap for reconnect backoff. */
  maxReconnectDelay?: number;
  /** Per-request timeout in ms. claude -p can take 30s+. */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PingResult {
  rttMs: number;
  serverTs: number;
}

const DEFAULT_INITIAL_DELAY = 1_000;
const DEFAULT_MAX_DELAY = 30_000;
const DEFAULT_REQUEST_TIMEOUT = 60_000;

export class NavettedClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private shouldReconnect = false;
  private reconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, PendingRequest>();

  private readonly url: string;
  private readonly token: string;
  private readonly clientId: string;
  private readonly onStatus?: (
    status: ConnectionStatus,
    detail?: string,
  ) => void;
  private readonly initialReconnectDelay: number;
  private readonly maxReconnectDelay: number;
  private readonly requestTimeoutMs: number;

  constructor(opts: NavettedClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.clientId = opts.clientId;
    this.onStatus = opts.onStatus;
    this.initialReconnectDelay =
      opts.initialReconnectDelay ?? DEFAULT_INITIAL_DELAY;
    this.maxReconnectDelay = opts.maxReconnectDelay ?? DEFAULT_MAX_DELAY;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
    this.reconnectDelay = this.initialReconnectDelay;
  }

  connect(): void {
    this.shouldReconnect = true;
    this.openSocket();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.failAllPending(new Error("Client disconnected"));
    this.setStatus("disconnected");
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  async captureIdea(payload: CaptureIdeaPayload): Promise<CaptureResponse> {
    const raw = await this.sendRequest("capture/idea", payload);
    return raw as unknown as CaptureResponse;
  }

  async captureJournal(payload: CaptureJournalPayload): Promise<CaptureResponse> {
    const raw = await this.sendRequest("capture/journal", payload);
    return raw as unknown as CaptureResponse;
  }

  async capturePerson(payload: CapturePersonPayload): Promise<CaptureResponse> {
    const raw = await this.sendRequest("capture/person", payload);
    return raw as unknown as CaptureResponse;
  }

  /**
   * Liveness + auth probe. Resolves with round-trip time and the server's
   * timestamp. Rejects on timeout, failed handshake, or connection loss.
   */
  async ping(): Promise<PingResult> {
    const t0 = Date.now();
    const raw = await this.sendRequest("ping", {});
    const rttMs = Date.now() - t0;
    const serverTs =
      typeof raw["server_ts"] === "number" ? raw["server_ts"] : 0;
    return { rttMs, serverTs };
  }

  /**
   * Promote an existing idea note's status field. The daemon rewrites the
   * `status:` line in the YAML frontmatter and returns the updated content.
   */
  async promoteIdea(
    filepath: string,
    status: IdeaStatus,
  ): Promise<CaptureResponse> {
    const payload: PromoteIdeaPayload = { filepath, status };
    const raw = await this.sendRequest("capture/idea/promote", payload);
    return raw as unknown as CaptureResponse;
  }

  /**
   * Low-level RPC primitive: send a JSON envelope with a uuid request_id and
   * resolve when the daemon responds with the matching request_id (regardless
   * of `type`). Caller is responsible for shaping the response.
   */
  private sendRequest(
    type: string,
    payload: object,
  ): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.status !== "connected" || !this.ws) {
        reject(new Error(`Not connected (status=${this.status})`));
        return;
      }
      const request_id = uuidv4();
      const envelope = { type, request_id, ...payload };
      const timer = setTimeout(() => {
        if (this.pending.delete(request_id)) {
          reject(
            new Error(
              `Request ${type} timed out after ${this.requestTimeoutMs}ms`,
            ),
          );
        }
      }, this.requestTimeoutMs);
      this.pending.set(request_id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(envelope));
      } catch (error: unknown) {
        clearTimeout(timer);
        this.pending.delete(request_id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private openSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (error: unknown) {
      this.handleSocketFailure(
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus("authenticating");
      ws.send(
        JSON.stringify({
          type: "hello",
          version: 2,
          client_id: this.clientId,
        }),
      );
    };

    ws.onmessage = (evt: MessageEvent) => {
      this.handleMessage(typeof evt.data === "string" ? evt.data : "");
    };

    ws.onerror = () => {
      this.setStatus("error", "WebSocket error");
    };

    ws.onclose = () => {
      this.failAllPending(new Error("Connection closed"));
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      } else {
        this.setStatus("disconnected");
      }
    };
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return;
    }
    const obj = parsed as Record<string, unknown>;
    const msgType = typeof obj["type"] === "string" ? obj["type"] : "";

    if (msgType === "challenge") {
      const nonce = typeof obj["nonce"] === "string" ? obj["nonce"] : "";
      const hmac = HmacSHA256(nonce, this.token).toString(EncHex);
      this.ws?.send(JSON.stringify({ type: "challenge_response", hmac }));
      return;
    }

    if (msgType === "welcome") {
      this.reconnectDelay = this.initialReconnectDelay;
      this.setStatus("connected");
      return;
    }

    if (msgType === "rejected") {
      const reason =
        typeof obj["reason"] === "string" ? obj["reason"] : "rejected";
      this.shouldReconnect = false;
      this.setStatus("error", reason);
      this.ws?.close();
      return;
    }

    if (msgType === "capture_response" || msgType === "pong") {
      const request_id =
        typeof obj["request_id"] === "string" ? obj["request_id"] : "";
      const pending = this.pending.get(request_id);
      if (!pending) {
        return;
      }
      this.pending.delete(request_id);
      clearTimeout(pending.timer);
      pending.resolve(obj);
      return;
    }
  }

  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay,
    );
    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, delay);
  }

  private handleSocketFailure(detail: string): void {
    this.setStatus("error", detail);
    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.onStatus?.(status, detail);
  }
}
