/**
 * WebSocket message envelopes for capture/* RPCs against navetted.
 *
 * Wire format: every message carries a `type` discriminator. Capture requests
 * include a `request_id` (uuid) and the daemon echoes it back on the matching
 * `capture_response`. The shared client uses that to resolve the per-call
 * Promise.
 */

export type CaptureType =
  | "capture/idea"
  | "capture/journal"
  | "capture/person";

/**
 * Promote an existing idea note's `status:` frontmatter field. Filepath is
 * the absolute path the daemon previously returned in `CaptureResponse`.
 */
export interface PromoteIdeaPayload {
  filepath: string;
  status: "seedling" | "developing" | "mature";
}

/**
 * Liveness probe + handshake-validation message. Carries no payload; the
 * daemon replies with a `pong` containing a server-side timestamp so the
 * client can compute round-trip time and confirm auth still holds.
 */
export interface PongResponse {
  type: "pong";
  request_id: string;
  server_ts: number;
}

export interface CaptureIdeaPayload {
  text: string;
}

export interface CaptureJournalPayload {
  transcript: string;
  image_b64?: string;
}

export interface CapturePersonPayload {
  ocr_result: string;
  context?: string;
  image_b64?: string;
}

export type CapturePayload =
  | CaptureIdeaPayload
  | CaptureJournalPayload
  | CapturePersonPayload;

export interface CaptureRequestEnvelope {
  type: CaptureType;
  request_id: string;
  [field: string]: unknown;
}

export type CaptureStatus = "ok" | "error";

export interface CaptureResponse {
  type: "capture_response";
  request_id: string;
  status: CaptureStatus;
  filepath?: string;
  preview_markdown?: string;
  error?: string;
}

/**
 * Hello v2 handshake messages — match navetted's protocol exactly.
 * The client sends `hello`, server replies `challenge`, client responds with
 * `challenge_response` (HMAC-SHA256(nonce, token)), server replies `welcome`
 * or `rejected`.
 */
export interface HelloMessage {
  type: "hello";
  version: 2;
  client_id: string;
}

export interface ChallengeMessage {
  type: "challenge";
  nonce: string;
}

export interface ChallengeResponseMessage {
  type: "challenge_response";
  hmac: string;
}

export interface WelcomeMessage {
  type: "welcome";
  client_id?: string;
  head_seq?: number;
}

export interface RejectedMessage {
  type: "rejected";
  reason?: string;
}
