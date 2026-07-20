# Plan: local-LLM backend (disconnected/no-internet enrichment)

Status: design, approved by user, ready for implementation plan
Date: 2026-07-19
Origin: user request during this session — a settings option to route LLM
enrichment through a locally-hosted LLM (specifically Relais,
`com.ventouxlabs.relais.izzy`, already installed on the test Pixel) instead
of the cloud-routed OmniRoute proxy, for a fully disconnected/no-internet
capture flow. Corrects a stale auto-memory entry
(`relais-local-llm-enrichment-outages`) that had wrongly inferred Relais was
already in the OmniRoute path — user confirmed 2026-07-19 it is not; this
plan is what Relais is actually *for*.

**Distinct from** `.claude/PRPs/prds/on-device-backend.prd.md`'s `"on-device"`
backend (native Kotlin Gemma inference, unbuilt, Phases 2-4 of that PRD).
This plan targets a third `LlmBackend` value — a network HTTP client aimed at
a loopback/LAN server, structurally closer to `omniroute.ts` than to native
inference. It reuses the same dispatcher seam (B7 Phase 1, PR #72) both
tracks are designed against, but is otherwise independent — either can ship
without the other.

## Problem

OmniRoute enrichment requires reaching a self-hosted proxy over
Tailscale/VPN. There's no way to capture-and-enrich with zero network
connectivity today — a disconnected capture falls back to the save-first raw
note + pending-enrich queue, which still needs eventual connectivity to
resolve. Relais already runs a local LLM server on the test Pixel itself
(loopback `127.0.0.1:8080`, unauthenticated; LAN-facing `:8443` with a
required Bearer token — confirmed by the user), OpenAI-compatible
(`/v1/chat/completions`, and per the user, vision + `/v1/audio/transcriptions`
too, "but build that the endpoints could fail"). This plan wires that up as a
selectable backend.

## Design

### `apps/mobile/src/lib/localLlm.ts` (new)

Mirrors `omniroute.ts`'s six-function shape exactly — same signatures
`dispatcher.ts` already expects, same `EnrichResult = {markdown, model}`
return shape, same error-throwing contract (must satisfy
`isPermanentError()`/`isNotConfiguredError()` predicates, since the offline
queue and capture screens branch ONLY on those two predicates per
`on-device-backend.prd.md`'s already-verified interface-stability note — not
on concrete error types). Reuses `withTimeout`/AbortController from
`httpClient.ts`, same `FETCH_TIMEOUT_MS` pattern.

Divergences from `omniroute.ts`:
- Base URL defaults to `http://127.0.0.1:8080` (Relais's unauthenticated
  loopback port) instead of requiring user entry.
- `Authorization` header sent only if `localLlmApiKey` is configured —
  `omniroute.ts` already has this exact conditional (it just always has a key
  in practice); no new logic, same code shape.
- One model field only (`localLlmModel`), used for text, vision, and audio —
  no separate vision-model split like OmniRoute's
  `omniRouteModel`/`omniRouteVisionModel`. If vision/audio calls fail against
  that model (endpoint missing, model doesn't support the modality), the
  error surfaces through the SAME save-first + pending-retry path OmniRoute
  failures already use — no bespoke fallback branch.
- No auto-fallback to OmniRoute on failure — selecting `"local"` is an
  exclusive switch. This is a deliberate privacy/intent choice: a user who
  picked "disconnected" should never have a capture silently leak to the
  cloud proxy because Relais hiccuped.

### `settings.ts`

- `LlmBackend` type: `"omniroute" | "on-device" | "local"` (extends the
  existing type; `"on-device"` stays reserved/unused until its own PRD ships).
- New `PersistedSettings` fields (AsyncStorage, plaintext — matching how
  `omniRouteUrl`/`omniRouteModel` are stored today):
  - `localLlmUrl: string` (default `"http://127.0.0.1:8080"`)
  - `localLlmModel: string` (default `""`, same "must configure" UX as
    OmniRoute's model field)
- New SecureStore-backed field (matching `OMNIROUTE_API_KEY`'s pattern):
  - `localLlmApiKey?: string` — optional; blank by default since the
    loopback port needs none. Kept available for a future LAN
    (`:8443`-with-auth) use case without a schema change later.

### `netAllowlist.ts`

No change. `isAllowedPlaintextHost` already permits `localhost`/`127.0.0.1`
for plaintext HTTP (RFC1918 + loopback allowlist from B0). Verify this at
implementation time with a quick existing-test read, but the explore pass
already confirmed the allowlist's shape covers this case.

### `dispatcher.ts`

Grows the `getLlmBackend()`-driven switch its own comment already
anticipates ("When a second backend lands, only this module changes"). Three
cases now: `"omniroute"` (existing), `"local"` (new, routes to
`localLlm.ts`), `"on-device"` (still throws/no-ops — unbuilt, out of scope
here). Callers (`CaptureScreen`, `queue.ts`, etc.) do not change.

### `SettingsScreen.tsx`

- New "Local LLM" section, structurally mirroring the existing "Connection"
  (OmniRoute) section: URL field, model field, optional API-key field.
- A backend picker (e.g. `SegmentedButtons`) selecting `llmBackend` between
  "OmniRoute" and "Local" — `"on-device"` omitted from the picker until its
  own PRD ships (matches `settingsForm.ts`'s existing note that "Phase 1 has
  no picker UI"; this plan is what finally adds one, just for these two
  options).
- Conditional rendering: show the OmniRoute section when `llmBackend ===
  "omniroute"`, the Local LLM section when `llmBackend === "local"` — same
  conditional pattern the file already uses for the dark-mode theme picker.
- **Test connection** (small, optional but cheap): a button pinging
  `${localLlmUrl}/health` (confirmed unauthenticated on both Relais ports)
  and reporting reachable/unreachable — partially closes the long-deferred
  TODO.md carry-over item "Settings: live connection test," scoped to this
  new backend only (OmniRoute's own live-connection-test remains a separate,
  still-deferred item).

### Testing

- `localLlm.test.ts` (new) — mirrors `omniroute.test.ts`'s mock-fetch
  patterns: text enrichment success, vision/audio endpoint failure handling
  (surfaces as a normal permanent/transient error, not a crash), no-API-key
  request (confirms no `Authorization` header sent), configured-API-key
  request (confirms header sent).
- `dispatcher.test.ts` — extend for the new `"local"` switch branch.
- `settingsForm.test.ts` / `SettingsScreen.test.tsx` — extend for the new
  fields, the backend picker, and the test-connection button.

## Non-goals

- Native on-device inference (Gemma) — separate PRD, separate track.
- Auto-fallback between backends on failure — explicit user choice from
  brainstorming.
- Separate vision/audio model fields — one model field, per user's choice.
- Workstation Ollama / any daemon-dependent local backend — TODO.md already
  rejects this pattern explicitly (re-introduces the reachability dependency
  v0.2 removed); Relais's loopback-HTTP shape is different in kind (no
  daemon reachability problem — it's the same device).
- Editing Relais's own config/model management — out of scope, Relais owns
  that.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Relais's vision/audio endpoints don't actually match OpenAI's shape despite being "OpenAI-compatible" for chat | Medium | User explicitly asked to "build that the endpoints could fail" — standard error-path handling (save-first + pending-retry), no code assumes success |
| User accidentally leaves `"local"` selected while away from the device that runs Relais (e.g. borrowed/reset device) | Low | Same failure mode as OmniRoute being unreachable — save-first + pending-retry queue already handles "configured backend not reachable right now" gracefully |
| SecureStore field added for an API key that's unused in the common (loopback, no-auth) case | Low | Matches the existing `omniRouteApiKey` pattern exactly — zero new risk surface, and keeps the schema forward-compatible with a LAN/`:8443` mode later without a migration |

## Open decisions (resolved during brainstorming, 2026-07-19)

- Deployment target: localhost on the phone itself (Relais), not a separate
  LAN device.
- API shape: OpenAI-compatible.
- Scope: all six dispatcher functions (text, vision, OCR, audio) — not
  text-only.
- Auth: loopback port is unauthenticated; API key field stays optional.
- Model config: one model field covers text/vision/audio, not a split.
- Fallback behavior: exclusive switch, no auto-fallback to OmniRoute.
- Naming: generic "local LLM" backend (works with any OpenAI-compatible
  local server), not Relais-specific in code or copy.
