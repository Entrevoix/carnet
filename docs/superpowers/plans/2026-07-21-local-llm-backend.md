# Local-LLM Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third, selectable LLM backend ("local") that routes all enrichment through a loopback OpenAI-compatible server (Relais, `http://127.0.0.1:8080` by default) instead of OmniRoute, for a fully disconnected/no-internet capture flow, with a Settings UI to configure and switch to it.

**Architecture:** `localLlm.ts` is a new HTTP client mirroring `omniroute.ts`'s shape exactly (same function signatures, same error-classification contract). `dispatcher.ts` — currently static re-exports — becomes async wrapper functions that read `Settings.llmBackend` per call and delegate to the selected backend. `settings.ts` grows the local-LLM config fields. `settingsForm.ts` + `SettingsScreen.tsx` add the backend picker and a "Local LLM" settings section.

## Global Constraints

- No SQLite (repo-wide constraint) — all new state goes through the existing AsyncStorage/SecureStore split already used by `settings.ts`.
- API keys must live in `expo-secure-store`, never AsyncStorage/plaintext (CLAUDE.md hard constraint) — mirror the existing `omniRouteApiKey`/`karakeepApiKey` pattern exactly.
- No new dependency.
- Selecting `"local"` is an exclusive switch — no auto-fallback to OmniRoute on failure (resolved brainstorming decision).
- One model field covers text, vision, and audio-adjacent calls for the local backend — no separate vision-model split (resolved brainstorming decision).
- `tsc --noEmit`, `npm -w @carnet/mobile run lint`, and `npm -w @carnet/mobile test` must all pass before each commit.
- Source design doc: `.claude/PRPs/plans/local-llm-backend.plan.md` — read it for the full rationale; this plan implements it.

---

## File Structure

- **Modify:** `apps/mobile/src/lib/omniroute.ts` — generalize `isPermanentError`/`isNotConfiguredError` to classify via the shared `HttpError` base instead of the `OmniRouteError` subclass.
- **Modify:** `apps/mobile/src/lib/settings.ts` — add `"local"` to `LlmBackend`, add `localLlmUrl`/`localLlmModel`/`localLlmApiKey` fields + SecureStore getter/setter pair.
- **Create:** `apps/mobile/src/lib/localLlm.ts` — the new backend client (8 functions: `enrichIdea`, `enrichJournal`, `enrichPerson`, `enrichSharedImage`, `enrichSharedLink`, `promoteIdea`, `ocrCardViaVision`, `listModels`, plus `healthCheck`).
- **Create:** `apps/mobile/src/lib/localLlm.test.ts` — mirrors `omniroute.test.ts`'s mock-fetch pattern.
- **Modify:** `apps/mobile/src/lib/dispatcher.ts` — static re-exports become async backend-routing wrapper functions for the 8 divergent calls; `transcribeAudio`/`autoTranscribeIfEnabled`/`isPermanentError`/`isNotConfiguredError`/`EnrichResult` stay static re-exports from `omniroute.ts` (backend-agnostic).
- **Modify:** `apps/mobile/src/lib/dispatcher.test.ts` — replace the reference-identity test with a backend-routing behavior test.
- **Modify:** `apps/mobile/src/lib/settingsForm.ts` — `FormState`/`ExistingApiKeys` grow local-LLM fields; `composeSettingsForSave` stops hardcoding `DEFAULT_LLM_BACKEND`.
- **Modify:** `apps/mobile/src/lib/settingsForm.test.ts` — extend fixtures.
- **Modify:** `apps/mobile/src/screens/SettingsScreen.tsx` — backend picker, conditional OmniRoute/Local sections, Test Connection button. No new test file — this screen has zero test coverage today (matches its existing untested handlers like `openBrowse`/`handleToggleNotification`); the state-shaping logic this UI drives lives in the already-tested `settingsForm.ts`.
- **Modify (mechanical, multi-site):** `apps/mobile/src/lib/omniroute.test.ts`, `apps/mobile/src/lib/dispatcher.test.ts`, `apps/mobile/src/lib/karakeep.test.ts`, `apps/mobile/src/lib/settingsForm.test.ts`, `apps/mobile/src/lib/settings.test.ts` — every full `Settings`-shaped object literal in these files needs the 3 new fields added, or `tsc` fails with a missing-property error at each site (this is the verification gate, not something to hand-track by line number). Handled inside Task 2.

---

### Task 1: Generalize error classification to the shared `HttpError` base

**Files:**
- Modify: `apps/mobile/src/lib/omniroute.ts:108-120`
- Test: `apps/mobile/src/lib/omniroute.test.ts` (existing predicate tests must still pass unchanged — this is a behavior-preserving generalization)

**Interfaces:**
- Consumes: `HttpError` from `./httpClient` (already imported at `omniroute.ts:28`).
- Produces: `isPermanentError(err: unknown): boolean` and `isNotConfiguredError(err: unknown): boolean` now classify ANY `HttpError` subclass, not just `OmniRouteError` — Task 3's `LocalLlmError extends HttpError` will be classified correctly without dispatcher.ts needing backend-aware predicate switching.

**Why:** `on-device-backend.prd.md`'s own documented contract says a new backend's errors must "satisfy the two predicates" — today they check `instanceof OmniRouteError` specifically, so a `LocalLlmError` (which will legitimately extend the shared `HttpError` base, matching `KarakeepError`'s existing precedent at `karakeep.ts:34`) would silently fail classification. Broadening the check to the shared base is a minimal, behavior-preserving fix: `OmniRouteError extends HttpError`, so every existing call site's result is unchanged.

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/src/lib/omniroute.test.ts`, near the existing `isPermanentError`/`isNotConfiguredError` tests (search for `describe("isPermanentError"` or similar — if no dedicated describe block exists, add one after the existing error-predicate assertions in the file):

```ts
import { HttpError } from "./httpClient";

describe("isPermanentError / isNotConfiguredError generalize to HttpError", () => {
  it("classifies a non-OmniRouteError HttpError subclass by its status/notConfigured fields", () => {
    class FakeBackendError extends HttpError {}
    const permanent = new FakeBackendError("bad request", 400);
    const notConfigured = new FakeBackendError("no url", 0, { notConfigured: true });
    const transient = new FakeBackendError("network blip", 0);

    expect(isPermanentError(permanent)).toBe(true);
    expect(isNotConfiguredError(notConfigured)).toBe(true);
    expect(isPermanentError(notConfigured)).toBe(false);
    expect(isPermanentError(transient)).toBe(false);
    expect(isNotConfiguredError(transient)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @carnet/mobile test -- omniroute.test.ts -t "generalize to HttpError"`
Expected: FAIL — `isPermanentError(permanent)` is `false` because `FakeBackendError` is not `instanceof OmniRouteError`.

- [ ] **Step 3: Implement**

In `apps/mobile/src/lib/omniroute.ts`, replace lines 108-120:

```ts
/** True for HTTP statuses that indicate a permanent failure — caller should
 * NOT enqueue these for automatic retry. Classifies via the shared HttpError
 * base (not the OmniRouteError subclass specifically) so any backend's
 * client — a second HttpError subclass, e.g. a local-LLM client — is
 * classified correctly without dispatcher.ts needing per-backend predicates. */
export function isPermanentError(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  return err.status >= 400 && err.status < 500;
}

/** True when the request failed because the backend is not configured (blank
 * URL). Distinct from a transient network status-0 error: retrying/queuing is
 * pointless until the user sets a URL, so the caller should surface this. */
export function isNotConfiguredError(err: unknown): boolean {
  return err instanceof HttpError && err.notConfigured;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w @carnet/mobile test -- omniroute.test.ts`
Expected: PASS — the new test plus every existing predicate test (they all use `OmniRouteError`, which is still `instanceof HttpError`, so behavior is unchanged for them).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/omniroute.ts apps/mobile/src/lib/omniroute.test.ts
git commit -m "refactor(dispatch): classify error predicates via the shared HttpError base"
```

---

### Task 2: `settings.ts` — local-LLM schema + secure-store plumbing

**Files:**
- Modify: `apps/mobile/src/lib/settings.ts`
- Test: `apps/mobile/src/lib/settings.test.ts`
- Mechanical fixture updates: `apps/mobile/src/lib/omniroute.test.ts`, `apps/mobile/src/lib/dispatcher.test.ts`, `apps/mobile/src/lib/karakeep.test.ts`, `apps/mobile/src/lib/settingsForm.test.ts`

**Interfaces:**
- Produces: `Settings.localLlmUrl: string`, `Settings.localLlmModel: string`, `Settings.localLlmApiKey: string`; `LlmBackend = "omniroute" | "on-device" | "local"`; `hasLocalLlmApiKey(): Promise<boolean>`; `setLocalLlmApiKey(value: string): Promise<void>` — Task 3 (`localLlm.ts`) reads `localLlmUrl`/`localLlmModel`/`localLlmApiKey` via `getSettings()`; Task 6 (`SettingsScreen.tsx`) calls `hasLocalLlmApiKey`/`setLocalLlmApiKey` mirroring the existing OmniRoute key UI.

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/src/lib/settings.test.ts` (find the existing `describe("hasOmniRouteApiKey"` / `setOmniRouteApiKey"` block and add a parallel one after it — mirror its exact shape, substituting local-LLM names):

```ts
describe("hasLocalLlmApiKey / setLocalLlmApiKey", () => {
  it("reports false when no key is stored, true after setting one, false after clearing", async () => {
    expect(await hasLocalLlmApiKey()).toBe(false);

    await setLocalLlmApiKey("local-secret-token");
    expect(await hasLocalLlmApiKey()).toBe(true);

    await setLocalLlmApiKey("");
    expect(await hasLocalLlmApiKey()).toBe(false);
  });
});

describe("localLlmUrl / localLlmModel default via getSettings", () => {
  it("defaults localLlmUrl and localLlmModel to empty strings on a fresh install", async () => {
    const s = await getSettings();
    expect(s.localLlmUrl).toBe("");
    expect(s.localLlmModel).toBe("");
    expect(s.localLlmApiKey).toBe("");
  });

  it("round-trips localLlmUrl/localLlmModel through saveSettings", async () => {
    const s = await getSettings();
    await saveSettings({ ...s, localLlmUrl: "http://127.0.0.1:8080", localLlmModel: "gemma-4" });
    const after = await getSettings();
    expect(after.localLlmUrl).toBe("http://127.0.0.1:8080");
    expect(after.localLlmModel).toBe("gemma-4");
  });
});
```

Add `hasLocalLlmApiKey`, `setLocalLlmApiKey` to this test file's existing import from `./settings` (find the `import { ... } from "./settings"` line and extend it).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @carnet/mobile test -- settings.test.ts -t "hasLocalLlmApiKey"`
Expected: FAIL — `hasLocalLlmApiKey is not a function` / `does not provide an export named 'hasLocalLlmApiKey'`.

- [ ] **Step 3: Implement the schema + plumbing**

In `apps/mobile/src/lib/settings.ts`:

Line 10-11, add a third SecureStore key constant:

```ts
const OMNIROUTE_API_KEY = "carnet_omniroute_api_key";
const KARAKEEP_API_KEY = "carnet_karakeep_api_key";
const LOCAL_LLM_API_KEY = "carnet_local_llm_api_key";
```

Line 33, extend the `LlmBackend` type:

```ts
/**
 * Enrichment backend selector (Stage 2 / branch B7, extended for the
 * local-LLM backend). `"omniroute"` is the shipped default; `"local"` routes
 * to a loopback/LAN OpenAI-compatible server (e.g. Relais) for a fully
 * disconnected capture flow; `"on-device"` is reserved for the pluggable
 * native-inference backend (unbuilt — see on-device-backend.prd.md) and has
 * no picker UI entry yet. Persisted as a plain string in the AsyncStorage
 * settings blob — non-secret, so old blobs without the key take the default
 * via the `{...DEFAULT_PERSISTED, ...parsed}` spread in readPersisted.
 */
export type LlmBackend = "omniroute" | "on-device" | "local";
```

Line 51-97 (`Settings` interface), add after `omniRouteVisionModel` (after line 60):

```ts
  /** Base URL for the local-LLM backend (e.g. a loopback Relais server).
   * Blank means "use the default loopback port" — unlike omniRouteUrl, a
   * blank value does NOT mean "not configured": the local backend's client
   * (localLlm.ts) falls back to http://127.0.0.1:8080 rather than throwing,
   * since the whole point is a zero-setup disconnected flow. */
  localLlmUrl: string;
  /** Model name for the local-LLM backend — used for text, vision, AND
   * audio-adjacent calls (unlike OmniRoute's separate chat/vision split):
   * a local single-model deployment typically has one model handling
   * everything the user configured it with. */
  localLlmModel: string;
  /** Local-LLM API key (Bearer). Held in SecureStore, never persisted to the
   * AsyncStorage settings blob — mirrors omniRouteApiKey/karakeepApiKey.
   * Optional in practice: Relais's loopback port is unauthenticated, but the
   * field stays available for a LAN-facing/authenticated deployment. */
  localLlmApiKey: string;
```

Line 99-111 (`PersistedSettings` interface), add after `omniRouteVisionModel`:

```ts
  localLlmUrl: string;
  localLlmModel: string;
```

(`localLlmApiKey` is NOT added here — it's SecureStore-only, mirroring `omniRouteApiKey`'s exclusion from `PersistedSettings`.)

Line 120-132 (`DEFAULT_PERSISTED`), add:

```ts
  localLlmUrl: "",
  localLlmModel: "",
```

Line 146-185 (`readPersisted`), the v1-migration branch (lines 166-178) constructs a full `PersistedSettings` object literal by hand — add the two new fields there too:

```ts
      return {
        omniRouteUrl: legacy.omniRouteUrl ?? "",
        omniRouteModel: DEFAULT_OMNIROUTE_MODEL,
        omniRouteVisionModel: DEFAULT_VISION_MODEL,
        llmBackend: DEFAULT_LLM_BACKEND,
        localLlmUrl: "",
        localLlmModel: "",
        persistentNotificationEnabled: false,
        autoTranscribeOnSave: false,
        richEditorEnabled: true,
        previewBeforeSave: false,
        captureFolderPath: legacy.captureFolderPath ?? "",
        promptOverrides: {},
        karakeepUrl: "",
      };
```

Line 187-202 (`writePersisted`), add to the `sanitised` object literal:

```ts
    localLlmUrl: settings.localLlmUrl,
    localLlmModel: settings.localLlmModel,
```

Line 221-244 (`getSettings`), add a `localLlmApiKey` SecureStore read alongside the existing two, and include the three new fields in the returned object:

```ts
export async function getSettings(): Promise<Settings> {
  await purgeLegacySecretsOnce();
  const persisted = await readPersisted();
  const omniRouteApiKey =
    (await SecureStore.getItemAsync(OMNIROUTE_API_KEY)) ?? "";
  const karakeepApiKey =
    (await SecureStore.getItemAsync(KARAKEEP_API_KEY)) ?? "";
  const localLlmApiKey =
    (await SecureStore.getItemAsync(LOCAL_LLM_API_KEY)) ?? "";

  return {
    omniRouteUrl: persisted.omniRouteUrl,
    omniRouteApiKey,
    omniRouteModel: persisted.omniRouteModel,
    omniRouteVisionModel: persisted.omniRouteVisionModel,
    llmBackend: persisted.llmBackend,
    localLlmUrl: persisted.localLlmUrl,
    localLlmModel: persisted.localLlmModel,
    localLlmApiKey,
    persistentNotificationEnabled: persisted.persistentNotificationEnabled,
    autoTranscribeOnSave: persisted.autoTranscribeOnSave,
    richEditorEnabled: persisted.richEditorEnabled,
    previewBeforeSave: persisted.previewBeforeSave,
    captureFolderPath: persisted.captureFolderPath,
    promptOverrides: persisted.promptOverrides,
    karakeepUrl: persisted.karakeepUrl,
    karakeepApiKey,
  };
}
```

Line 246-270 (`saveSettings`), add `localLlmUrl`/`localLlmModel` to the `writePersisted` call, and a `localLlmApiKey` SecureStore write/delete mirroring the other two:

```ts
export async function saveSettings(settings: Settings): Promise<void> {
  await writePersisted({
    omniRouteUrl: settings.omniRouteUrl,
    omniRouteModel: settings.omniRouteModel,
    omniRouteVisionModel: settings.omniRouteVisionModel,
    llmBackend: settings.llmBackend,
    localLlmUrl: settings.localLlmUrl,
    localLlmModel: settings.localLlmModel,
    persistentNotificationEnabled: settings.persistentNotificationEnabled,
    autoTranscribeOnSave: settings.autoTranscribeOnSave,
    richEditorEnabled: settings.richEditorEnabled,
    previewBeforeSave: settings.previewBeforeSave,
    captureFolderPath: settings.captureFolderPath,
    promptOverrides: settings.promptOverrides,
    karakeepUrl: settings.karakeepUrl,
  });
  if (settings.omniRouteApiKey) {
    await SecureStore.setItemAsync(OMNIROUTE_API_KEY, settings.omniRouteApiKey);
  } else {
    await SecureStore.deleteItemAsync(OMNIROUTE_API_KEY);
  }
  if (settings.karakeepApiKey) {
    await SecureStore.setItemAsync(KARAKEEP_API_KEY, settings.karakeepApiKey);
  } else {
    await SecureStore.deleteItemAsync(KARAKEEP_API_KEY);
  }
  if (settings.localLlmApiKey) {
    await SecureStore.setItemAsync(LOCAL_LLM_API_KEY, settings.localLlmApiKey);
  } else {
    await SecureStore.deleteItemAsync(LOCAL_LLM_API_KEY);
  }
}
```

After the existing `hasKarakeepApiKey`/`setKarakeepApiKey` functions (end of file, after line 316), add the mirrored pair:

```ts
/**
 * True if there is a local-LLM API key stored in SecureStore. Used by the
 * settings UI to render a "•••• configured" placeholder rather than reading
 * the key into React state for display.
 */
export async function hasLocalLlmApiKey(): Promise<boolean> {
  const key = await SecureStore.getItemAsync(LOCAL_LLM_API_KEY);
  return Boolean(key && key.trim().length > 0);
}

/** Write-only setter for the local-LLM API key. Used by the settings UI. */
export async function setLocalLlmApiKey(value: string): Promise<void> {
  if (value && value.trim().length > 0) {
    await SecureStore.setItemAsync(LOCAL_LLM_API_KEY, value.trim());
  } else {
    await SecureStore.deleteItemAsync(LOCAL_LLM_API_KEY);
  }
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npm -w @carnet/mobile test -- settings.test.ts`
Expected: PASS for the new tests. Other tests in this file may now FAIL if they construct a full `Settings`/`PersistedSettings` object literal without the 3 new fields — fix those the same way as Step 5 below (this file is in-scope for the mechanical fixture pass too).

- [ ] **Step 5: Fix every other Settings-shaped fixture across the codebase**

Run: `npm -w @carnet/mobile run typecheck`

This will report a `TS2741`/`TS2739`-style "missing properties" error at every object literal typed (directly or via a mocked function's inferred return) as `Settings` that doesn't yet have `localLlmUrl`/`localLlmModel`/`localLlmApiKey`. Known sites (confirmed via `grep -rln "karakeepApiKey" apps/mobile/src`):
- `apps/mobile/src/lib/omniroute.test.ts` — `BASE_SETTINGS` (one `vi.hoisted` fixture)
- `apps/mobile/src/lib/dispatcher.test.ts` — `BASE_SETTINGS` (one `vi.hoisted` fixture)
- `apps/mobile/src/lib/karakeep.test.ts` — its `Settings`-shaped fixture(s)
- `apps/mobile/src/lib/settingsForm.test.ts` — multiple inline literals (`baseForm`, and object-spread variants — grep found occurrences at lines 34, 46, 55, 65, 79, 93, 96 as of this plan's writing; re-grep, don't trust these line numbers, they will have shifted after Task 2's own edits)

At every site `tsc` reports (and any this plan's `grep` missed — `tsc` is the authoritative check here, not this list), add these three lines immediately after the existing `karakeepApiKey:` (or `omniRouteVisionModel:`, whichever the object literal has) line, with values matching that fixture's existing style (usually `""` for the two string fields, matching how `karakeepUrl`/`karakeepApiKey` are typically defaulted to `""` in these same fixtures):

```ts
    localLlmUrl: "",
    localLlmModel: "",
    localLlmApiKey: "",
```

Re-run `npm -w @carnet/mobile run typecheck` after each fix and repeat until it reports zero errors — this is the actual completion signal for this step, not a fixed count of sites.

- [ ] **Step 6: Run the full mobile gate**

Run: `npm -w @carnet/mobile run typecheck && npm -w @carnet/mobile run lint && npm -w @carnet/mobile test`
Expected: all three PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/lib/settings.ts apps/mobile/src/lib/settings.test.ts apps/mobile/src/lib/omniroute.test.ts apps/mobile/src/lib/dispatcher.test.ts apps/mobile/src/lib/karakeep.test.ts apps/mobile/src/lib/settingsForm.test.ts
git commit -m "feat(settings): local-LLM backend config fields + secure-store plumbing"
```

---

### Task 3: `localLlm.ts` — the new backend client

**Files:**
- Create: `apps/mobile/src/lib/localLlm.ts`
- Create: `apps/mobile/src/lib/localLlm.test.ts`

**Interfaces:**
- Consumes: `getSettings`/`getPromptOverrides` from `./settings` (Task 2's new fields); `HttpError`/`parseErrorBody`/`sanitizeErrorMessage`/`withTimeout` from `./httpClient`; `isCredentialSafeUrl` from `./netAllowlist` (already permits `127.0.0.1`/`localhost` over plain HTTP — confirmed, no changes needed there); `sanitizeAndNormalize`/`sanitizeMarkdown`/`NoteType` from `./enrichSanitize`; `buildIdeaPrompt`/`buildJournalPrompt`/`buildPersonPrompt`/`buildPromoteIdeaPrompt`/`buildSharedImagePrompt`/`buildSharedLinkPrompt`/`PromptPair` from `./prompts`; `withSystemOverride` — this is currently only exported from `./omniroute` (`omniroute.ts:56-63`) and is backend-agnostic pure logic (no OmniRoute-specific behavior) — import it from `./omniroute` rather than duplicating it; `fetchUrlPreview`/`UrlPreview` from `./urlpreview`; `EnrichResult` type from `./omniroute` (re-export, don't redefine — Task 4 needs one canonical `EnrichResult`).
- Produces: `LocalLlmError` (extends `HttpError`), `enrichIdea`, `enrichJournal`, `enrichPerson`, `enrichSharedImage`, `enrichSharedLink`, `promoteIdea`, `ocrCardViaVision(input): Promise<{ text: string }>`, `listModels(baseUrl, apiKey): Promise<string[]>`, `healthCheck(baseUrl): Promise<boolean>` — Task 4 (`dispatcher.ts`) imports all 8 enrich/OCR/listModels functions; Task 6 (`SettingsScreen.tsx`) imports `healthCheck` for the Test Connection button.

- [ ] **Step 1: Write the failing tests**

Create `apps/mobile/src/lib/localLlm.test.ts`, mirroring `omniroute.test.ts`'s mock setup exactly (same `vi.mock("./settings", ...)`, same global `fetchMock`, same `makeOkResponse`/`makeErrorResponse` helpers) but with a `BASE_SETTINGS` fixture using the local-LLM fields:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { BASE_SETTINGS } = vi.hoisted(() => ({
  BASE_SETTINGS: {
    omniRouteUrl: "",
    omniRouteApiKey: "",
    omniRouteModel: "",
    omniRouteVisionModel: "",
    llmBackend: "local" as const,
    localLlmUrl: "http://127.0.0.1:8080",
    localLlmModel: "test-local-model",
    localLlmApiKey: "",
    persistentNotificationEnabled: false,
    autoTranscribeOnSave: false,
    richEditorEnabled: false,
    previewBeforeSave: false,
    captureFolderPath: "",
    promptOverrides: {},
    karakeepUrl: "",
    karakeepApiKey: "",
  },
}));

vi.mock("./settings", () => ({
  getSettings: vi.fn().mockResolvedValue(BASE_SETTINGS),
  getPromptOverrides: vi.fn().mockResolvedValue({}),
}));

function makeOkResponse(markdown: string, model = "test-local-model"): Response {
  const body = JSON.stringify({
    model,
    choices: [{ message: { role: "assistant", content: markdown } }],
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeErrorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import {
  enrichIdea,
  ocrCardViaVision,
  listModels,
  healthCheck,
  LocalLlmError,
  isPermanentError,
  isNotConfiguredError,
} from "./localLlm";
import { getSettings } from "./settings";

beforeEach(() => {
  fetchMock.mockReset();
});

describe("localLlm.enrichIdea", () => {
  it("posts to the configured base URL's /v1/chat/completions with no Authorization header when no API key is set", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\nstatus: seedling\n---\n# Idea\n\nbody\n"),
    );

    await enrichIdea("a raw thought");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("test-local-model");
  });

  it("sends an Authorization header when a local-LLM API key is configured", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({
      ...BASE_SETTINGS,
      localLlmApiKey: "local-secret",
    });
    fetchMock.mockResolvedValueOnce(makeOkResponse("# Idea\n\nbody\n"));

    await enrichIdea("a raw thought");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer local-secret");
  });

  it("defaults to http://127.0.0.1:8080 when localLlmUrl is blank, rather than throwing not-configured", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({ ...BASE_SETTINGS, localLlmUrl: "" });
    fetchMock.mockResolvedValueOnce(makeOkResponse("# Idea\n\nbody\n"));

    await enrichIdea("a raw thought");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
  });

  it("classifies a 4xx response as a permanent LocalLlmError", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse(400, "bad request"));

    const err = await enrichIdea("doomed").then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(LocalLlmError);
    expect(isPermanentError(err)).toBe(true);
    expect(isNotConfiguredError(err)).toBe(false);
  });
});

describe("localLlm.ocrCardViaVision", () => {
  it("uses the single configured model (no separate vision model)", async () => {
    fetchMock.mockResolvedValueOnce(makeOkResponse("Jane Doe\nCEO\njane@example.com"));

    const result = await ocrCardViaVision({ base64: "abc123", mimeType: "image/jpeg" });

    expect(result.text).toBe("Jane Doe\nCEO\njane@example.com");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("test-local-model");
  });
});

describe("localLlm.listModels", () => {
  it("fetches GET /v1/models and returns sorted unique ids", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const models = await listModels("http://127.0.0.1:8080", "");

    expect(models).toEqual(["a-model", "b-model"]);
  });
});

describe("localLlm.healthCheck", () => {
  it("returns true when /health responds ok", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    expect(await healthCheck("http://127.0.0.1:8080")).toBe(true);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/health");
  });

  it("returns false when /health is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    expect(await healthCheck("http://127.0.0.1:8080")).toBe(false);
  });

  it("returns false when /health responds non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await healthCheck("http://127.0.0.1:8080")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm -w @carnet/mobile test -- localLlm.test.ts`
Expected: FAIL — `Cannot find module './localLlm'`.

- [ ] **Step 3: Implement `localLlm.ts`**

```ts
/**
 * Local-LLM client for carnet — an OpenAI-compatible HTTP client aimed at a
 * loopback/LAN server (Relais by default, or any other OpenAI-compatible
 * local deployment) instead of OmniRoute's cloud-routed proxy. Structurally
 * mirrors omniroute.ts (same function signatures, same error-classification
 * contract via the shared HttpError base — see the isPermanentError/
 * isNotConfiguredError generalization in omniroute.ts) so dispatcher.ts can
 * route to either backend transparently.
 *
 * Divergences from omniroute.ts, all deliberate (see
 * .claude/PRPs/plans/local-llm-backend.plan.md):
 *   - Blank localLlmUrl defaults to http://127.0.0.1:8080 rather than
 *     throwing not-configured — the whole point is a zero-setup disconnected
 *     flow (Relais already runs on-device with no user action required).
 *   - One model field (localLlmModel) covers text AND vision — no separate
 *     vision-model split like OmniRoute's chat/vision divide.
 *   - No auto-fallback to OmniRoute on failure — selecting "local" is
 *     exclusive by design (privacy: a disconnected user's capture should
 *     never silently reach the cloud proxy).
 *   - transcribeAudio/autoTranscribeIfEnabled are NOT implemented here —
 *     they're already backend-agnostic (on-device speech recognition,
 *     omniroute.ts:663-731) and dispatcher.ts routes them to omniroute.ts
 *     unconditionally regardless of the selected backend.
 */

import { sanitizeAndNormalize, sanitizeMarkdown, type NoteType } from "./enrichSanitize";
import { getPromptOverrides, getSettings } from "./settings";
import {
  buildIdeaPrompt,
  buildJournalPrompt,
  buildPersonPrompt,
  buildPromoteIdeaPrompt,
  buildSharedImagePrompt,
  buildSharedLinkPrompt,
  type PromptPair,
} from "./prompts";
import { isCredentialSafeUrl } from "./netAllowlist";
import {
  HttpError,
  parseErrorBody,
  sanitizeErrorMessage,
  withTimeout,
} from "./httpClient";
import { fetchUrlPreview, type UrlPreview } from "./urlpreview";
import { withSystemOverride, type EnrichResult } from "./omniroute";

export type { EnrichResult };

/** Default base URL when localLlmUrl is blank — Relais's unauthenticated
 * loopback port. Unlike OmniRoute, a blank URL is a valid, expected state
 * (zero-setup disconnected flow), not a not-configured error. */
const DEFAULT_LOCAL_LLM_URL = "http://127.0.0.1:8080";

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

interface OpenAIChoice {
  message: OpenAIMessage;
}

interface OpenAIResponse {
  model?: string;
  choices?: OpenAIChoice[];
  error?: { message?: string };
}

/** Error thrown by the local-LLM client. Extends the shared HttpError base
 * (see httpClient.ts) so isPermanentError/isNotConfiguredError — generalized
 * in omniroute.ts to check HttpError rather than OmniRouteError specifically
 * — classify these correctly without dispatcher.ts needing backend-aware
 * predicates. Mirrors KarakeepError's identical precedent (karakeep.ts:34). */
export class LocalLlmError extends HttpError {
  constructor(message: string, status: number, opts?: { notConfigured?: boolean }) {
    super(message, status, opts);
    this.name = "LocalLlmError";
  }
}

/** Re-exported for callers that want backend-specific predicates directly
 * (dispatcher.ts uses the generalized omniroute.ts versions instead, which
 * work for either backend — these are here for symmetry/direct-import
 * callers and for this file's own tests). */
export function isPermanentError(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  return err.status >= 400 && err.status < 500;
}

export function isNotConfiguredError(err: unknown): boolean {
  return err instanceof HttpError && err.notConfigured;
}

const FETCH_TIMEOUT_MS = 20_000;

function localLlmTimeoutError(ms: number): LocalLlmError {
  return new LocalLlmError(
    `Local LLM unreachable — timed out after ${Math.round(ms / 1000)}s.`,
    0,
  );
}

function assertHttpsOrLocal(trimmed: string): void {
  if (isCredentialSafeUrl(trimmed)) return;
  throw new LocalLlmError(
    "Local LLM URL must use https:// (or be a loopback/LAN address) to protect the API key",
    0,
  );
}

/** Strip a leading ``` fence (and matching trailer) — identical logic to
 * omniroute.ts's stripCodeFences; duplicated rather than imported since
 * omniroute.ts doesn't export it (it's a private helper there too). */
function stripCodeFences(raw: string): string {
  const leftTrimmed = raw.trimStart();
  if (!leftTrimmed.startsWith("```")) return raw;
  const rest = leftTrimmed.slice(3);
  const afterLang = rest.includes("\n") ? rest.slice(rest.indexOf("\n") + 1) : rest;
  const stripped = afterLang.trimEnd().endsWith("```")
    ? afterLang.trimEnd().slice(0, -3).trimEnd()
    : afterLang;
  return stripped;
}

async function executeChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: OpenAIMessage[],
  noteType: NoteType,
): Promise<EnrichResult> {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  assertHttpsOrLocal(trimmed);

  const url = `${trimmed}/v1/chat/completions`;
  const body = JSON.stringify({ model, messages, stream: false });

  return await withTimeout(FETCH_TIMEOUT_MS, localLlmTimeoutError, async (signal) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body,
        signal,
      });
    } catch (e: unknown) {
      if (e instanceof LocalLlmError) throw e;
      const raw = e instanceof Error ? e.message : String(e);
      throw new LocalLlmError(`Local LLM network error — ${sanitizeErrorMessage(raw)}`, 0);
    }

    if (!response.ok) {
      throw new LocalLlmError(
        `Local LLM error — ${await parseErrorBody(response)}`,
        response.status,
      );
    }

    const json = (await response.json()) as OpenAIResponse;
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim().length) {
      throw new LocalLlmError("Local LLM returned an empty or malformed response", response.status);
    }

    const stripped = stripCodeFences(content);
    const markdown = sanitizeAndNormalize(stripped, noteType) ?? sanitizeMarkdown(stripped);
    const modelUsed = json.model ?? model;
    return { markdown, model: modelUsed };
  });
}

async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: PromptPair,
  noteType: NoteType,
): Promise<EnrichResult> {
  const messages: OpenAIMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  return executeChat(baseUrl, apiKey, model, messages, noteType);
}

async function getBaseUrl(): Promise<string> {
  const settings = await getSettings();
  const url = settings.localLlmUrl.trim();
  return url || DEFAULT_LOCAL_LLM_URL;
}

async function getApiKey(): Promise<string> {
  const settings = await getSettings();
  return settings.localLlmApiKey ?? "";
}

/** Single model for text AND vision — see the file header's divergence
 * note. Unlike omniroute's getModel(), a blank model IS surfaced as
 * not-configured (there's no sensible hard-coded default for an arbitrary
 * local deployment the way "openrouter/openai/gpt-4o-mini" is a sensible
 * OmniRoute default). */
async function getModel(): Promise<string> {
  const settings = await getSettings();
  const model = settings.localLlmModel.trim();
  if (!model) {
    throw new LocalLlmError("Local LLM model not configured — set it in Settings", 0, {
      notConfigured: true,
    });
  }
  return model;
}

export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const trimmed = (baseUrl.trim() || DEFAULT_LOCAL_LLM_URL).replace(/\/+$/, "");
  assertHttpsOrLocal(trimmed);

  const url = `${trimmed}/v1/models`;

  return await withTimeout(FETCH_TIMEOUT_MS, localLlmTimeoutError, async (signal) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        signal,
      });
    } catch (e: unknown) {
      if (e instanceof LocalLlmError) throw e;
      const raw = e instanceof Error ? e.message : String(e);
      throw new LocalLlmError(`Local LLM network error — ${sanitizeErrorMessage(raw)}`, 0);
    }

    if (!response.ok) {
      throw new LocalLlmError(`Local LLM error — ${await parseErrorBody(response)}`, response.status);
    }

    const json = (await response.json()) as { data?: Array<{ id?: string }> };
    const ids = (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return [...new Set(ids)].sort();
  });
}

/** Reachability check for the Settings screen's "Test Connection" button.
 * Never throws — returns false on any failure (timeout, network error,
 * non-2xx). Confirmed unauthenticated on both of Relais's ports, so no
 * Authorization header is sent. Deliberately does NOT go through
 * assertHttpsOrLocal/isCredentialSafeUrl's throw-on-unsafe-URL path — a
 * connectivity CHECK should report false for an unsafe URL, not throw and
 * crash the button handler. */
export async function healthCheck(baseUrl: string): Promise<boolean> {
  const trimmed = (baseUrl.trim() || DEFAULT_LOCAL_LLM_URL).replace(/\/+$/, "");
  if (!isCredentialSafeUrl(trimmed)) return false;
  try {
    return await withTimeout(FETCH_TIMEOUT_MS, localLlmTimeoutError, async (signal) => {
      const response = await fetch(`${trimmed}/health`, { method: "GET", signal });
      return response.ok;
    });
  } catch {
    return false;
  }
}

// ── Public API — mirrors omniroute.ts's shape exactly ──────────────────────

export async function enrichIdea(text: string): Promise<EnrichResult> {
  const [baseUrl, apiKey, model, overrides] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
    getPromptOverrides(),
  ]);
  const pair = withSystemOverride(buildIdeaPrompt(text), overrides.idea);
  return chatCompletion(baseUrl, apiKey, model, pair, "idea");
}

export async function enrichJournal(input: {
  transcript: string;
  notes: string;
}): Promise<EnrichResult> {
  const [baseUrl, apiKey, model, overrides] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
    getPromptOverrides(),
  ]);
  const pair = withSystemOverride(
    buildJournalPrompt(input.transcript, input.notes),
    overrides.journal,
  );
  return chatCompletion(baseUrl, apiKey, model, pair, "journal");
}

export async function enrichPerson(input: {
  ocrResult: string;
  context: string;
}): Promise<EnrichResult> {
  const [baseUrl, apiKey, model, overrides] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
    getPromptOverrides(),
  ]);
  const pair = withSystemOverride(
    buildPersonPrompt(input.ocrResult, input.context),
    overrides.person,
  );
  return chatCompletion(baseUrl, apiKey, model, pair, "person");
}

export async function enrichSharedImage(input: {
  base64: string;
  mimeType: string;
  context: string;
}): Promise<EnrichResult> {
  const safeMime = /^image\/(jpe?g|png|webp|gif|heic|heif)$/.test(input.mimeType)
    ? input.mimeType
    : "image/jpeg";
  const [baseUrl, apiKey, model, overrides] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
    getPromptOverrides(),
  ]);
  const { system: defaultSystem, userText } = buildSharedImagePrompt(input.context);
  const systemOverride = overrides.sharedImage?.trim() ?? "";
  const system = systemOverride || defaultSystem;
  const dataUrl = `data:${safeMime};base64,${input.base64}`;
  const messages: OpenAIMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
  return executeChat(baseUrl, apiKey, model, messages, "shared");
}

const OCR_CARD_PROMPT =
  "Transcribe ALL text on this business card exactly as printed. Preserve every field: name, title, company, phone numbers, email addresses, websites, physical address, and any other text. Output plain text, one field per line. Do not invent, omit, or normalize anything.";

export async function ocrCardViaVision(input: {
  base64: string;
  mimeType: string;
}): Promise<{ text: string }> {
  const safeMime = /^image\/(jpe?g|png|webp|gif|heic|heif)$/.test(input.mimeType)
    ? input.mimeType
    : "image/jpeg";
  const [baseUrl, apiKey, model] = await Promise.all([getBaseUrl(), getApiKey(), getModel()]);
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  assertHttpsOrLocal(trimmed);

  const dataUrl = `data:${safeMime};base64,${input.base64}`;
  const messages: OpenAIMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: OCR_CARD_PROMPT },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
  const url = `${trimmed}/v1/chat/completions`;
  const body = JSON.stringify({ model, messages, stream: false, temperature: 0 });

  return await withTimeout(FETCH_TIMEOUT_MS, localLlmTimeoutError, async (signal) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body,
        signal,
      });
    } catch (e: unknown) {
      if (e instanceof LocalLlmError) throw e;
      const raw = e instanceof Error ? e.message : String(e);
      throw new LocalLlmError(`Local LLM network error — ${sanitizeErrorMessage(raw)}`, 0);
    }

    if (!response.ok) {
      throw new LocalLlmError(`Local LLM error — ${await parseErrorBody(response)}`, response.status);
    }

    const json = (await response.json()) as OpenAIResponse;
    const content = json.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) {
      throw new LocalLlmError("Local LLM response contained no OCR text", response.status);
    }
    return { text };
  });
}

export async function enrichSharedLink(input: {
  url: string;
  text: string;
  context: string;
  onPreviewSettled?: () => void;
}): Promise<EnrichResult> {
  const previewPromise: Promise<UrlPreview | null> = input.url
    ? fetchUrlPreview(input.url)
    : Promise.resolve(null);
  if (input.onPreviewSettled) {
    const fireSettled = (): void => {
      try {
        input.onPreviewSettled?.();
      } catch {
        // swallow — caller's UI state is best-effort
      }
    };
    void previewPromise.then(fireSettled, fireSettled);
  }
  const [baseUrl, apiKey, model, preview, overrides] = await Promise.all([
    getBaseUrl(),
    getApiKey(),
    getModel(),
    previewPromise,
    getPromptOverrides(),
  ]);
  const pair = withSystemOverride(
    buildSharedLinkPrompt(input.url, input.text, input.context, preview),
    overrides.sharedLink,
  );
  return chatCompletion(baseUrl, apiKey, model, pair, "shared");
}

export async function promoteIdea(
  currentMarkdown: string,
  target: Parameters<typeof buildPromoteIdeaPrompt>[1],
): Promise<EnrichResult> {
  const [baseUrl, apiKey, model] = await Promise.all([getBaseUrl(), getApiKey(), getModel()]);
  return chatCompletion(
    baseUrl,
    apiKey,
    model,
    buildPromoteIdeaPrompt(currentMarkdown, target),
    "idea",
  );
}
```

Note: `promoteIdea`'s second parameter uses `Parameters<typeof buildPromoteIdeaPrompt>[1]` instead of importing `IdeaStatus` from `@carnet/shared` directly — either works; if `tsc` complains about this indirection, import `type { IdeaStatus } from "@carnet/shared"` and type it directly as `omniroute.ts:739` does, for consistency.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm -w @carnet/mobile test -- localLlm.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full mobile gate**

Run: `npm -w @carnet/mobile run typecheck && npm -w @carnet/mobile run lint && npm -w @carnet/mobile test`
Expected: all three PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/lib/localLlm.ts apps/mobile/src/lib/localLlm.test.ts
git commit -m "feat(local-llm): new backend client — loopback OpenAI-compatible enrichment"
```

---

### Task 4: `dispatcher.ts` — backend-routing wrapper functions

**Files:**
- Modify: `apps/mobile/src/lib/dispatcher.ts`
- Modify: `apps/mobile/src/lib/dispatcher.test.ts`

**Interfaces:**
- Consumes: all 8 divergent functions from `./omniroute` and `./localLlm` (Task 3); `getSettings`/`LlmBackend` from `./settings` (Task 2).
- Produces: same 8 function names as before (`enrichIdea`, `enrichJournal`, `enrichPerson`, `enrichSharedImage`, `enrichSharedLink`, `promoteIdea`, `ocrCardViaVision`, `listModels`), now async wrappers instead of static re-exports — every existing caller (`CaptureScreen`, `queue.ts`, `SettingsScreen.tsx`'s `openBrowse`) is unaffected since the call signature (`dispatcher.enrichIdea(text)`) is unchanged, only the underlying reference is no longer `=== omniroute.enrichIdea`.

- [ ] **Step 1: Write the failing test**

In `apps/mobile/src/lib/dispatcher.test.ts`, replace the first test in the `describe("dispatcher re-export identity (online + drain parity)"` block (lines 93-101 — the reference-identity assertions, which are inherently incompatible with runtime backend routing) with a routing behavior test. Also add `vi.mock("./localLlm", ...)` alongside the existing mocks so the new backend is controllable.

Add near the top, after the existing `vi.mock("./writer", ...)` block:

```ts
vi.mock("./localLlm", () => ({
  enrichIdea: vi.fn(),
  enrichJournal: vi.fn(),
  enrichPerson: vi.fn(),
  enrichSharedImage: vi.fn(),
  enrichSharedLink: vi.fn(),
  promoteIdea: vi.fn(),
  ocrCardViaVision: vi.fn(),
  listModels: vi.fn(),
}));
```

Add the import near the existing `import * as omniroute from "./omniroute";`:

```ts
import * as localLlm from "./localLlm";
```

Replace lines 93-101 (`it("re-exports the exact same six enrich functions as omniroute", ...)`) with:

```ts
describe("dispatcher backend routing", () => {
  it("routes to omniroute's enrichIdea when llmBackend is 'omniroute' (the default)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeOkResponse("---\nstatus: seedling\n---\n# Idea\n\nbody\n"),
    );

    await enrichIdea("route to omniroute");

    expect(localLlm.enrichIdea).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // omniroute's real HTTP path fired
  });

  it("routes to localLlm's enrichIdea when llmBackend is 'local'", async () => {
    vi.mocked(getSettings).mockResolvedValueOnce({ ...BASE_SETTINGS, llmBackend: "local" });
    vi.mocked(localLlm.enrichIdea).mockResolvedValueOnce({
      markdown: "# from local\n",
      model: "local-model",
    });

    const result = await enrichIdea("route to local");

    expect(localLlm.enrichIdea).toHaveBeenCalledWith("route to local");
    expect(fetchMock).not.toHaveBeenCalled(); // omniroute's HTTP path did NOT fire
    expect(result.markdown).toBe("# from local\n");
  });
});
```

Keep the existing `describe("dispatcher preserves error classification", ...)` block unchanged (lines 154-204) — those tests exercise the default `"omniroute"` backend path via `BASE_SETTINGS`, which is still valid.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm -w @carnet/mobile test -- dispatcher.test.ts`
Expected: FAIL — the "routes to localLlm" test fails because `dispatcher.enrichIdea` is currently a static re-export of `omniroute.enrichIdea`, so it always hits the OmniRoute HTTP path regardless of `llmBackend`.

- [ ] **Step 3: Implement the routing wrappers**

Replace `apps/mobile/src/lib/dispatcher.ts` entirely:

```ts
/**
 * Enrichment backend dispatcher (Stage 2 / branch B7, extended for the
 * local-LLM backend).
 *
 * The single seam through which callers reach the eight backend-divergent
 * enrichment functions, decoupling them from any one concrete backend.
 * `Settings.llmBackend` selects which backend serves a capture — read fresh
 * on EVERY call (not cached), so a user flipping the picker mid-session
 * takes effect on their very next capture.
 *
 * transcribeAudio/autoTranscribeIfEnabled/isPermanentError/
 * isNotConfiguredError/EnrichResult stay static re-exports from omniroute.ts
 * — they're backend-agnostic (transcription is on-device speech recognition
 * regardless of llmBackend; the error predicates were generalized in
 * omniroute.ts to classify via the shared HttpError base, so they work for
 * either backend's error class without a switch here).
 *
 * "on-device" (native Gemma inference) has no implementation yet and no
 * Settings UI picker entry — routing to it throws a clear error rather than
 * silently falling back, so a stray/malformed persisted value fails loudly
 * instead of masquerading as one of the two real backends.
 */

import { getSettings, type LlmBackend } from "./settings";
import * as omniroute from "./omniroute";
import * as localLlm from "./localLlm";
import type { EnrichResult } from "./omniroute";

export {
  transcribeAudio,
  autoTranscribeIfEnabled,
  isPermanentError,
  isNotConfiguredError,
} from "./omniroute";
export type { EnrichResult } from "./omniroute";

type DivergentBackend = typeof omniroute | typeof localLlm;

function backendFor(backend: LlmBackend): DivergentBackend {
  if (backend === "local") return localLlm;
  if (backend === "omniroute") return omniroute;
  throw new Error(`Backend "${backend}" has no implementation yet`);
}

async function currentBackend(): Promise<DivergentBackend> {
  const settings = await getSettings();
  return backendFor(settings.llmBackend);
}

export async function enrichIdea(text: string): Promise<EnrichResult> {
  const backend = await currentBackend();
  return backend.enrichIdea(text);
}

export async function enrichJournal(input: {
  transcript: string;
  notes: string;
}): Promise<EnrichResult> {
  const backend = await currentBackend();
  return backend.enrichJournal(input);
}

export async function enrichPerson(input: {
  ocrResult: string;
  context: string;
}): Promise<EnrichResult> {
  const backend = await currentBackend();
  return backend.enrichPerson(input);
}

export async function enrichSharedImage(input: {
  base64: string;
  mimeType: string;
  context: string;
}): Promise<EnrichResult> {
  const backend = await currentBackend();
  return backend.enrichSharedImage(input);
}

export async function enrichSharedLink(input: {
  url: string;
  text: string;
  context: string;
  onPreviewSettled?: () => void;
}): Promise<EnrichResult> {
  const backend = await currentBackend();
  return backend.enrichSharedLink(input);
}

export async function promoteIdea(
  currentMarkdown: string,
  target: Parameters<typeof omniroute.promoteIdea>[1],
): Promise<EnrichResult> {
  const backend = await currentBackend();
  return backend.promoteIdea(currentMarkdown, target);
}

export async function ocrCardViaVision(input: {
  base64: string;
  mimeType: string;
}): Promise<{ text: string }> {
  const backend = await currentBackend();
  return backend.ocrCardViaVision(input);
}

export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const backend = await currentBackend();
  return backend.listModels(baseUrl, apiKey);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm -w @carnet/mobile test -- dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full mobile gate**

Run: `npm -w @carnet/mobile run typecheck && npm -w @carnet/mobile run lint && npm -w @carnet/mobile test`
Expected: all three PASS — this is the step that confirms no other caller (`CaptureScreen.tsx`, `queue.ts`, `SettingsScreen.tsx`) broke from the reference-identity change, since they only ever call `dispatcher.enrichIdea(...)` etc., never compare function references.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/lib/dispatcher.ts apps/mobile/src/lib/dispatcher.test.ts
git commit -m "feat(dispatch): route enrichment calls to the selected backend per-call"
```

---

### Task 5: `settingsForm.ts` — backend picker + local-LLM form fields

**Files:**
- Modify: `apps/mobile/src/lib/settingsForm.ts`
- Modify: `apps/mobile/src/lib/settingsForm.test.ts`

**Interfaces:**
- Produces: `FormState.llmBackend: LlmBackend`, `FormState.localLlmUrl: string`, `FormState.localLlmModel: string`, `ExistingApiKeys.localLlmApiKey: string`; `composeSettingsForSave` now passes `form.llmBackend` through instead of hardcoding `DEFAULT_LLM_BACKEND` — Task 6 (`SettingsScreen.tsx`) reads/writes these via `form`/`update()`.

- [ ] **Step 1: Write the failing test**

In `apps/mobile/src/lib/settingsForm.test.ts`, find the existing `composeSettingsForSave` test block and its `baseForm`/fixture literals (grep confirmed occurrences around lines 34-96 as of this plan's writing — re-check current line numbers, they will have shifted after Task 2's fixture edits). Add `llmBackend`, `localLlmUrl`, `localLlmModel` to every `FormState`-typed fixture, and `localLlmApiKey` to every `ExistingApiKeys`-typed fixture, mirroring how `karakeepUrl`/`karakeepApiKey` are already present in those same fixtures. Then add a new test:

```ts
it("passes the user's selected llmBackend through instead of forcing the default", () => {
  const form: FormState = {
    ...baseForm,
    llmBackend: "local",
    localLlmUrl: "http://127.0.0.1:8080",
    localLlmModel: "gemma-4",
  };
  const result = composeSettingsForSave(form, {
    omniRouteApiKey: "",
    karakeepApiKey: "",
    localLlmApiKey: "local-key",
  });

  expect(result.llmBackend).toBe("local");
  expect(result.localLlmUrl).toBe("http://127.0.0.1:8080");
  expect(result.localLlmModel).toBe("gemma-4");
  expect(result.localLlmApiKey).toBe("local-key");
});
```

(Import `LlmBackend` from `./settings` in this test file if not already imported, for the `llmBackend: "local"` literal to type-check against `FormState.llmBackend: LlmBackend`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @carnet/mobile test -- settingsForm.test.ts -t "passes the user's selected llmBackend"`
Expected: FAIL — `Object literal may only specify known properties, and 'llmBackend' does not exist in type 'FormState'` (a `tsc`-caught failure, or a runtime `result.llmBackend` being `"omniroute"` instead of `"local"` once the type error is worked around — either way, fails before Step 3).

- [ ] **Step 3: Implement**

In `apps/mobile/src/lib/settingsForm.ts`:

Update the import (line 9-15) to add `LlmBackend`:

```ts
import {
  DEFAULT_LLM_BACKEND,
  DEFAULT_OMNIROUTE_MODEL,
  DEFAULT_VISION_MODEL,
  type LlmBackend,
  type PromptOverrides,
  type Settings,
} from "./settings";
```

Update `FormState` (lines 21-32), add after `omniRouteVisionModel`:

```ts
export interface FormState {
  omniRouteUrl: string;
  omniRouteModel: string;
  omniRouteVisionModel: string;
  llmBackend: LlmBackend;
  localLlmUrl: string;
  localLlmModel: string;
  persistentNotificationEnabled: boolean;
  autoTranscribeOnSave: boolean;
  richEditorEnabled: boolean;
  previewBeforeSave: boolean;
  captureFolderPath: string;
  promptOverrides: PromptOverrides;
  karakeepUrl: string;
}
```

Update `ExistingApiKeys` (lines 36-39), add `localLlmApiKey`:

```ts
export interface ExistingApiKeys {
  omniRouteApiKey: string;
  karakeepApiKey: string;
  localLlmApiKey: string;
}
```

Update `composeSettingsForSave` (lines 50-69) — replace the hardcoded `llmBackend: DEFAULT_LLM_BACKEND` with `form.llmBackend`, and thread the new fields:

```ts
export function composeSettingsForSave(
  form: FormState,
  existing: ExistingApiKeys,
): Settings {
  return {
    omniRouteUrl: form.omniRouteUrl,
    omniRouteModel: form.omniRouteModel || DEFAULT_OMNIROUTE_MODEL,
    omniRouteVisionModel: form.omniRouteVisionModel || DEFAULT_VISION_MODEL,
    llmBackend: form.llmBackend,
    localLlmUrl: form.localLlmUrl,
    localLlmModel: form.localLlmModel,
    persistentNotificationEnabled: form.persistentNotificationEnabled,
    autoTranscribeOnSave: form.autoTranscribeOnSave,
    richEditorEnabled: form.richEditorEnabled,
    previewBeforeSave: form.previewBeforeSave,
    omniRouteApiKey: existing.omniRouteApiKey,
    captureFolderPath: form.captureFolderPath,
    promptOverrides: form.promptOverrides,
    karakeepUrl: form.karakeepUrl,
    karakeepApiKey: existing.karakeepApiKey,
    localLlmApiKey: existing.localLlmApiKey,
  };
}
```

`DEFAULT_LLM_BACKEND` stays imported (Task 6 needs it as the initial value when composing `FormState` from a freshly-loaded `Settings` — see Task 6, Step 3).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm -w @carnet/mobile test -- settingsForm.test.ts`
Expected: PASS — including every pre-existing test in this file, now with the 3 fixture fields added (Step 1 covers this).

- [ ] **Step 5: Run the full mobile gate**

Run: `npm -w @carnet/mobile run typecheck && npm -w @carnet/mobile run lint && npm -w @carnet/mobile test`
Expected: all three PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/lib/settingsForm.ts apps/mobile/src/lib/settingsForm.test.ts
git commit -m "feat(settings): thread the user's backend choice through composeSettingsForSave"
```

---

### Task 6: `SettingsScreen.tsx` — backend picker + Local LLM section + Test Connection

**Files:**
- Modify: `apps/mobile/src/screens/SettingsScreen.tsx`

No test file for this task — this screen has zero test coverage today (its existing async handlers like `openBrowse`/`handleToggleNotification` are also untested); the state-shaping logic this UI drives (`composeSettingsForSave`) is already covered by Task 5's tests, matching this file's established precedent (CLAUDE.md: prefer extracting non-UI logic into a tested `lib/*.ts` module over adding inline screen logic — already done here).

**Interfaces:**
- Consumes: `hasLocalLlmApiKey`/`setLocalLlmApiKey` from `./settings` (Task 2); `healthCheck` from `../lib/localLlm` (Task 3); `FormState`/`composeSettingsForSave` from `../lib/settingsForm` (Task 5).

- [ ] **Step 1: Add imports**

Add to the existing `import { ... } from "../lib/settings"` block (around line 20-32) — find `hasOmniRouteApiKey`, `setOmniRouteApiKey` and add the local-LLM pair alongside:

```ts
  hasLocalLlmApiKey,
  setLocalLlmApiKey,
```

Add a new import for `healthCheck`:

```ts
import { healthCheck } from "../lib/localLlm";
```

- [ ] **Step 2: Add state**

After the existing `pendingKarakeepKey` state (line 73), add:

```ts
  /** Local-LLM key state — mirrors the OmniRoute/Karakeep key pattern. */
  const [localLlmKeyConfigured, setLocalLlmKeyConfigured] = useState<boolean>(false);
  const [pendingLocalLlmKey, setPendingLocalLlmKey] = useState<string>("");
  /** Test Connection state for the Local LLM section. */
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<"ok" | "unreachable" | null>(null);
```

- [ ] **Step 3: Load local-LLM settings on mount**

In the mount `useEffect` (lines 102-151), add `hasLocalLlmApiKey()` to the `Promise.all` (line 104-109):

```ts
      const [s, hasKey, hasKkKey, hasLocalKey, banner] = await Promise.all([
        getSettings(),
        hasOmniRouteApiKey(),
        hasKarakeepApiKey(),
        hasLocalLlmApiKey(),
        shouldShowMigrationBanner(),
      ]);
```

Add `llmBackend`, `localLlmUrl`, `localLlmModel` to the `setForm({...})` call (lines 135-146):

```ts
      setForm({
        omniRouteUrl: s.omniRouteUrl,
        omniRouteModel: s.omniRouteModel,
        omniRouteVisionModel: s.omniRouteVisionModel,
        llmBackend: s.llmBackend,
        localLlmUrl: s.localLlmUrl,
        localLlmModel: s.localLlmModel,
        persistentNotificationEnabled: initialNotificationEnabled,
        autoTranscribeOnSave: s.autoTranscribeOnSave,
        richEditorEnabled: s.richEditorEnabled,
        previewBeforeSave: s.previewBeforeSave,
        captureFolderPath: s.captureFolderPath,
        promptOverrides: s.promptOverrides,
        karakeepUrl: s.karakeepUrl,
      });
      setKeyConfigured(hasKey);
      setKarakeepKeyConfigured(hasKkKey);
      setLocalLlmKeyConfigured(hasLocalKey);
      setShowBanner(banner);
```

- [ ] **Step 4: Wire the pending key into save + add a clear handler**

In the `save` function (lines 165-195), add local-LLM key persistence alongside the existing two:

```ts
      if (pendingKarakeepKey.length > 0) {
        await setKarakeepApiKey(pendingKarakeepKey);
        setPendingKarakeepKey("");
        setKarakeepKeyConfigured(true);
      }
      if (pendingLocalLlmKey.length > 0) {
        await setLocalLlmApiKey(pendingLocalLlmKey);
        setPendingLocalLlmKey("");
        setLocalLlmKeyConfigured(true);
      }
      setSaved(true);
```

After the existing `clearKarakeepKey` function (lines 210-219), add:

```ts
  const clearLocalLlmKey = async () => {
    try {
      await setLocalLlmApiKey("");
      setLocalLlmKeyConfigured(false);
      setPendingLocalLlmKey("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setPickerError(`Failed to clear the key: ${msg.slice(0, 120)}`);
    }
  };
```

- [ ] **Step 5: Add the Test Connection handler**

Near the `openBrowse` handler (around line 284), add:

```ts
  const testLocalLlmConnection = async () => {
    if (!form) return;
    setTestingConnection(true);
    setConnectionResult(null);
    const ok = await healthCheck(form.localLlmUrl);
    setConnectionResult(ok ? "ok" : "unreachable");
    setTestingConnection(false);
  };
```

- [ ] **Step 6: Update `currentKeysOrEmpty`**

At the bottom of the file (lines 782-791), add `localLlmApiKey`:

```ts
async function currentKeysOrEmpty(): Promise<{
  omniRouteApiKey: string;
  karakeepApiKey: string;
  localLlmApiKey: string;
}> {
  const s = await getSettings();
  return {
    omniRouteApiKey: s.omniRouteApiKey ?? "",
    karakeepApiKey: s.karakeepApiKey ?? "",
    localLlmApiKey: s.localLlmApiKey ?? "",
  };
}
```

- [ ] **Step 7: Add the backend picker + conditional sections in JSX**

Replace the existing "Connection" section header block (lines 373-378) with a backend picker followed by the SAME OmniRoute fields, now conditionally rendered, then a new conditionally-rendered Local LLM section. Insert BEFORE the existing `<Text variant="titleMedium" style={styles.sectionTitle}>Connection</Text>` line:

```tsx
      <Text variant="titleMedium" style={styles.sectionTitle}>
        Enrichment backend
      </Text>
      <HelperText type="info" visible>
        Where AI enrichment runs. OmniRoute is your self-hosted cloud-routed
        proxy; Local runs entirely on-device (or LAN) with no internet
        required.
      </HelperText>
      <SegmentedButtons
        value={form.llmBackend}
        onValueChange={(v) => update({ llmBackend: v as FormState["llmBackend"] })}
        buttons={[
          { value: "omniroute", label: "OmniRoute", icon: "cloud-outline" },
          { value: "local", label: "Local", icon: "cellphone-off" },
        ]}
        style={{ marginBottom: spacing.sm }}
      />
```

Then wrap the existing OmniRoute "Connection" section (the original lines 373-462, from `<Text variant="titleMedium" style={styles.sectionTitle}>Connection</Text>` through the closing of the vision-model "Browse available models" button) in a conditional:

```tsx
      {form.llmBackend === "omniroute" && (
        <>
          <Text variant="titleMedium" style={styles.sectionTitle}>
            Connection
          </Text>
          {/* ... existing OmniRoute URL / API key / Model / Vision model fields, unchanged ... */}
        </>
      )}

      {form.llmBackend === "local" && (
        <View style={styles.notificationSection}>
          <Text variant="titleMedium" style={styles.promptSectionTitle}>
            Local LLM
          </Text>
          <HelperText type="info" visible>
            A loopback or LAN OpenAI-compatible server (e.g. Relais). Blank
            URL defaults to http://127.0.0.1:8080 — no setup needed if Relais
            is already running on this device.
          </HelperText>
          <TextInput
            {...caretProps(theme)}
            label="Local LLM URL"
            mode="outlined"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={form.localLlmUrl}
            onChangeText={(v) => update({ localLlmUrl: v })}
            placeholder="http://127.0.0.1:8080"
          />
          <HelperText type="info" visible>
            Local LLM base URL — loopback (127.0.0.1) or LAN addresses are
            allowed over plain http://; anything else must use https://.
          </HelperText>

          <TextInput
            {...caretProps(theme)}
            label={
              localLlmKeyConfigured && pendingLocalLlmKey.length === 0
                ? "Local LLM API key (configured)"
                : "Local LLM API key"
            }
            mode="outlined"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder={
              localLlmKeyConfigured
                ? "•••• configured — tap to replace"
                : "optional — leave blank for an unauthenticated loopback server"
            }
            value={pendingLocalLlmKey}
            onChangeText={setPendingLocalLlmKey}
          />
          <HelperText type="info" visible>
            Stored in the secure keychain. The existing key is never shown
            again. Most loopback deployments (e.g. Relais on this device)
            need no key at all.
          </HelperText>
          {localLlmKeyConfigured && (
            <Button mode="text" compact onPress={clearLocalLlmKey} style={styles.clearKey}>
              Clear key
            </Button>
          )}

          <TextInput
            {...caretProps(theme)}
            label="Model"
            mode="outlined"
            autoCapitalize="none"
            autoCorrect={false}
            value={form.localLlmModel}
            onChangeText={(v) => update({ localLlmModel: v })}
            placeholder="e.g. litert-community/gemma-4-E4B-it-litert-lm"
          />
          <HelperText type="info" visible>
            One model handles text, vision, and business-card OCR for the
            local backend — no separate vision-model field.
          </HelperText>

          <Button
            mode="text"
            icon="lan-connect"
            compact
            onPress={() => void testLocalLlmConnection()}
            loading={testingConnection}
            disabled={testingConnection}
            style={styles.browseBtn}
          >
            Test connection
          </Button>
          {connectionResult === "ok" && (
            <HelperText type="info" visible>
              ✓ Reachable
            </HelperText>
          )}
          {connectionResult === "unreachable" && (
            <HelperText type="error" visible>
              Unreachable — check the URL and that the server is running.
            </HelperText>
          )}
        </View>
      )}
```

- [ ] **Step 8: Run the full mobile gate**

Run: `npm -w @carnet/mobile run typecheck && npm -w @carnet/mobile run lint && npm -w @carnet/mobile test`
Expected: all three PASS.

- [ ] **Step 9: Manual on-device smoke check**

On the connected device: open Settings, confirm the new "Enrichment backend" picker appears above Connection, switch to "Local", confirm the OmniRoute section hides and a "Local LLM" section appears with URL/key/model fields defaulting sensibly, tap "Test connection" against a running Relais instance and confirm "✓ Reachable", save, capture an Idea, confirm it enriches via Relais (check the note's frontmatter `model:` field reflects the local model name, not an OmniRoute model). Switch back to OmniRoute and confirm captures route there again. This step is exploratory — note the outcome, don't block the commit on it if the automated gate is green.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/src/screens/SettingsScreen.tsx
git commit -m "feat(settings): backend picker, Local LLM section, Test Connection"
```

---

## Self-Review Notes (fixed inline before handoff)

- **Spec coverage:** Every section of `.claude/PRPs/plans/local-llm-backend.plan.md`'s design has a task: `localLlm.ts` (Task 3), settings schema (Task 2), dispatcher wiring (Task 4), Settings UI incl. Test Connection (Task 6). The spec's "No `netAllowlist.ts` changes" non-goal is honored — no task touches that file, and Task 3 explicitly reuses `isCredentialSafeUrl` unchanged.
- **Architecture correction found during planning:** The spec sketch assumed `dispatcher.ts` "grows a switch" without spelling out that it's currently STATIC re-exports incompatible with per-call backend selection — Task 4 makes this explicit (async wrapper functions) and updates the one existing test (`dispatcher.test.ts`'s reference-identity assertion) that the change legitimately breaks.
- **Scope correction found during planning:** `transcribeAudio`/`autoTranscribeIfEnabled` turned out to already be backend-agnostic (on-device speech recognition, not an HTTP call) — Task 3's `localLlm.ts` does NOT reimplement them; Task 4's dispatcher re-exports them statically from `omniroute.ts` unchanged, same as today.
- **Correctness gap found during planning:** the existing `isPermanentError`/`isNotConfiguredError` check `instanceof OmniRouteError` specifically, which would silently misclassify every local-backend error — Task 1 generalizes this to the shared `HttpError` base before Task 3 introduces the second `HttpError` subclass, so nothing downstream (the offline queue, capture-screen error UI) needs backend-aware branching.
- **Blast-radius correction found during planning:** adding 3 required fields to `Settings` breaks every full-`Settings`-literal test fixture across 5 files — Task 2 handles this as a `tsc`-driven mechanical pass (verification gate, not hand-tracked line numbers) rather than pretending it's a single-file change.
- **Type consistency:** `EnrichResult` is defined once (`omniroute.ts`) and re-exported by both `localLlm.ts` (Task 3) and `dispatcher.ts` (Task 4) — no divergent redefinition. `LocalLlmError`/`isPermanentError`/`isNotConfiguredError` in `localLlm.ts` mirror `KarakeepError`'s established precedent (`karakeep.ts:34-50`) exactly.
- **Placeholder scan:** no TBD/TODO; every code step is complete, runnable code, not a description of what to write.
