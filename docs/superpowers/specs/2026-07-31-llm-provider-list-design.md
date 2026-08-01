# Design: LLM provider list

**Date:** 2026-07-31 · **Status:** approved, ready for implementation plan
**Supersedes:** the binary `llmBackend` switch (Stage 2 branch B7 Phase 1, PR #72)
**Related issues:** #83, #84, #85, #78, #75

## Problem

Carnet can talk to exactly two enrichment backends, chosen by a boolean-ish
setting: `llmBackend: "omniroute" | "on-device" | "local"`. `"on-device"` has no
implementation — `dispatcher.ts` says so in a comment — so in practice it is a
two-way switch between a hosted gateway and one hardcoded local URL.

The user wants to point Carnet at any OpenAI-compatible provider, with
localhost/Relais as one choice among several rather than a special case.

## Key finding: the two backends are the same client

`omniroute.ts` (710 lines) and `localLlm.ts` (455 lines) are near-duplicate
implementations of one OpenAI-compatible client:

- both POST to `${baseUrl}/v1/chat/completions`
- both GET `${baseUrl}/v1/models` for the model picker
- both import prompt assembly from the same `./prompts`
- both read `getPromptOverrides`/`getSettings` from `./settings`

They differ only in **which settings fields they read** and in the vision path
(`omniroute.ts` owns `ocrCardViaVision`; `localLlm.ts` has one model covering
text and vision).

This is what makes "every provider is just an entry" a real simplification
rather than a UI veneer: the duplication already exists and the feature is an
excuse to remove it.

## On-device inference IS a goal

Stated precisely, because an earlier draft of this spec got it wrong:
**inference on the handset is a goal.** It is delivered by running Relais on the
device and reaching it over `http://127.0.0.1:8080` — loopback needs no radio,
so airplane-mode capture genuinely works.

What is out of scope is only **embedding an inference runtime inside Carnet's
own process**: no MediaPipe/ExecuTorch/llama.cpp dependency, no `.so`, no ABI or
`largeHeap` concerns, no model download UX. The model is Relais's
responsibility, on whichever host Relais runs.

The usual configuration is a LAN/WAN Relais or a cloud provider; the on-handset
one is the offline backup.

## Non-goals

- Embedding a native inference runtime in Carnet (see above).
- Per-capture provider override. One primary, one offline fallback, one optional
  vision provider.
- Automatic rewriting of notes already written to the vault (see "Offline
  fallback" — re-enrichment is user-initiated).
- Streaming responses, cost tracking, provider-specific auth beyond a bearer
  token.

## Cleartext: loopback works, LAN is blocked (both verified on device)

An earlier draft of this spec called this a blocking prerequisite and claimed
loopback was broken on release builds. **That was wrong, and device testing
disproved it.**

### What was verified, on a device, 2026-08-01

Against the installed **release** APK (`targetSdk=36`, no `DEBUGGABLE` flag),
whose manifest genuinely contains neither `usesCleartextTraffic` nor
`networkSecurityConfig` (pulled from the device and decoded with `aapt2`):

- A real HTTP listener was placed on the device's `127.0.0.1:8080` via
  `adb reverse`.
- Carnet's own **Test connection** against `http://127.0.0.1:8080` returned
  **"✓ Reachable"**, with **no** cleartext error in logcat.

So cleartext to loopback works on release builds as shipped. The reason the
manifest reading was misleading: Android's default network security config for
targetSdk >= 28 blocks cleartext generally but **exempts loopback**. The
airplane-mode / Relais-on-handset story therefore needs no plugin and no
manifest change.

A first "Unreachable" result during the same session was a false alarm — nothing
was listening on the device's port 8080 at that moment. Relais was installed and
its process alive, but not serving. Worth remembering when interpreting a
failed health check: **"unreachable" usually means the server is not running,
not that the platform blocked it.**

### LAN cleartext IS blocked — verified, 2026-08-01

The **usual** configuration is a LAN/WAN Relais, and the loopback exemption does
not extend to a private-range address. Tested on the same release APK, against
the same HTTP server, in the same session:

| Path to the SAME server | Result |
|---|---|
| loopback `http://127.0.0.1:8080` (via `adb reverse`) | **✓ Reachable** |
| LAN `http://192.168.178.114:8080` (direct) | **Unreachable** |
| Chrome -> that same LAN URL | loads fine |

Every alternative explanation was eliminated before concluding:

- **Not the app's own allowlist.** `netAllowlist.ts:31-32` explicitly permits
  `192.168.0.0/16` for plaintext, so `healthCheck`'s `isCredentialSafeUrl` guard
  passes and the fetch is actually issued.
- **Not the server.** `http://192.168.178.114:8080/health` — the exact path
  `healthCheck` requests — returns HTTP 200.
- **Not the network or a host firewall.** Chrome on the same device loads the
  same URL; the listener is bound to `0.0.0.0`.
- **Not a response-parsing failure.** `healthCheck` only checks `response.ok`,
  and the loopback control hit the *same server* and returned Reachable.

So the platform blocks it. Note there is **no `CLEARTEXT ...` line in logcat** —
React Native's fetch surfaces it as a caught JS error and `healthCheck` swallows
it into `false`, so the failure is indistinguishable from "server is down" from
the user's side. That is itself a UX bug worth fixing alongside.

This exposes a real mismatch: the app's helper text tells the user *"loopback
(127.0.0.1) or LAN addresses are allowed over plain `http://`"* — true of
Carnet's **application-level** validation, but the **platform** then refuses the
connection, and the user is told only "Unreachable — check the URL and that the
server is running."

**Action:** add `plugins/withCleartextLocal.js` shipping an Android network
security config that permits cleartext **only** to RFC1918 ranges (loopback
already works without it) — never a blanket `usesCleartextTraffic="true"`, so
cleartext to arbitrary internet hosts stays blocked, consistent with #70.

Note while implementing: `isAllowedPlaintextHost` covers `10/8` and
`192.168/16` but **not `172.16/12`**, which is also RFC1918. Either add it or
document the omission; the plugin's config and that allowlist should agree.

This is independent of the rest of the design and ships on its own — it fixes a
live bug in today's local-LLM feature for every LAN user.

## Offline fallback

Local is not a peer the user picks manually — it is the automatic backup when
the internet is unavailable. Settings gains `fallbackProviderId: string | null`.

Resolution order for every enrichment call:

1. **Primary** (`activeProviderId`).
2. On an **unreachable-class** failure only, retry once against
   `fallbackProviderId`, if set.
3. If that also fails, fall into the **existing offline queue** unchanged.

Step 2 triggers on network/unreachable errors only — never on a permanent 4xx.
A 401 or a bad model id would fail identically against the fallback, and
silently succeeding on a smaller local model would mask a configuration problem
the user needs to see. `omniroute.ts`'s existing `isPermanentError` /
`isNotConfiguredError` predicates already make exactly this distinction via the
shared `HttpError` base, so no new classification is needed.

### Marking and re-enrichment

A note enriched by the fallback is **not** rewritten automatically — the user
asked for re-enrichment to be manual. Instead:

- The written note carries a frontmatter marker recording which provider
  enriched it (an additive field; it does not change how existing fields
  serialize, so the byte-compatibility constraint holds — but the frontmatter
  tests are the gate).
- `RecentDetailScreen` surfaces that marker and offers re-enrichment.

**This is mostly already built.** `lib/noteReprocess.ts` exposes `reEnrichNote`
and `RecentDetailScreen` already wires a Re-enrich action to it. The work here
is the marker plus surfacing it — not a new re-enrichment path.

## Architecture

### Before

```
dispatcher.backendFor(llmBackend) -> omniroute.* | localLlm.*   (whole-module swap)
```

### After

```
Settings -> resolveActiveProvider() -> ProviderConfig
                                          |
                                    llmClient.ts
                      (prompts + POST /v1/chat/completions + parse)
```

`dispatcher.ts` keeps its public surface (`enrichIdea`, `enrichJournal`,
`enrichPerson`, `enrichSharedImage`, `enrichSharedLink`, `promoteIdea`,
`ocrCardViaVision`, the error predicates, `EnrichResult`) so no caller changes.
Internally it resolves a config instead of swapping modules.

`backendFor()` and the `LlmBackend` union are deleted. The `"on-device"` member
goes with them rather than remaining as a type that documents a lie.

### Modules

| Module | Purpose | Depends on |
|---|---|---|
| `lib/llmProviders.ts` (new) | The `LlmProvider` type, the preset table, and pure helpers: `resolveActiveProvider`, `resolveVisionProvider`, `validateProvider`, `addCustomProvider`, `removeProvider`. No IO. | `./settings` types only |
| `lib/llmClient.ts` (new, from the merge) | One OpenAI-compatible client: prompt assembly, POST, response parse, error mapping. Takes a `ProviderConfig` argument — reads no settings itself. | `./prompts`, `./httpError` |
| `lib/dispatcher.ts` (rewritten, same surface) | Reads settings, resolves the provider, calls `llmClient`. | `./llmProviders`, `./llmClient`, `./settings` |
| `lib/providerKeys.ts` (new) | Per-provider secure-store key IO: `getKey(id)`, `setKey(id, v)`, `deleteKey(id)`. | `expo-secure-store` |
| `components/LlmProviderSection.tsx` (new) | The Settings UI. | props only |

`omniroute.ts` and `localLlm.ts` are deleted once `llmClient.ts` subsumes them.
Their existing tests (64 + the localLlm suite) are retargeted at `llmClient.ts`,
not deleted — they are the safety net for the merge.

## Data model

```ts
/** One configured LLM endpoint. Presets and custom entries share this shape. */
export interface LlmProvider {
  /** Stable id. Preset ids are fixed literals; custom ids are `custom-<n>`. */
  id: string;
  /** Display name. Editable for custom entries, fixed for presets. */
  label: string;
  /** OpenAI-compatible root, no trailing slash, no `/v1` suffix. */
  baseUrl: string;
  /** Chat/text model id. */
  model: string;
  /** Vision model id; "" means this provider cannot serve vision. */
  visionModel: string;
  /** Which preset this came from; null for user-created entries. For a preset
   * entry this always equals `id` — it is kept as a separate field so the only
   * check anywhere is `preset === null` ("is this user-created?"), rather than
   * matching ids against the preset table. */
  preset: string | null;
}
```

Custom ids are `custom-<n>`, where `n` is one past the highest existing custom
suffix — a counter, not a UUID, because Hermes has no `crypto.randomUUID` (the
same constraint that forced `expo-crypto` for #86).

Settings gains:

```ts
llmProviders: LlmProvider[];       // presets (possibly edited) + custom entries
activeProviderId: string;          // primary — serves captures
fallbackProviderId: string | null; // used only on an unreachable-class failure
visionProviderId: string | null;   // used when the serving entry has no visionModel
```

The three ids are independent: the usual setup is a LAN/WAN or cloud primary,
`relais` as the fallback, and a vision-capable cloud entry for vision.

Settings loses: `llmBackend`, `omniRouteUrl`, `omniRouteModel`,
`omniRouteVisionModel`, `localLlmUrl`, `localLlmModel`.

### Presets

Shipped presets (base URLs only; the user supplies key and model):

| id | label | baseUrl | key required |
|---|---|---|---|
| `relais` | Relais (local) | `http://127.0.0.1:8080` | no |
| `omniroute` | OmniRoute | *(from migration; blank for new installs)* | yes |
| `openai` | OpenAI | `https://api.openai.com` | yes |
| `groq` | Groq | `https://api.groq.com/openai` | yes |
| `openrouter` | OpenRouter | `https://openrouter.ai/api` | yes |

Ollama and LM Studio are deliberately not presets — custom entries cover them,
and the user did not ask for them.

Preset `baseUrl` is a **default, not a constraint**: the user can edit it (a
Relais on the LAN is not on `127.0.0.1`). Editing a preset does not turn it into
a custom entry; `preset` stays set so a future release can update the default
for untouched fields.

### API keys

Keys stay in `expo-secure-store` under `carnet.llm.key.<providerId>`, never in
the settings blob (hard constraint, `CLAUDE.md`). Removing a custom provider
deletes its key in the same operation. `providerKeys.ts` is the only module
that touches secure-store for this.

## Migration

Runs once, on first read of a settings blob that has `llmBackend` but no
`llmProviders`:

1. Build the preset list.
2. Fold `omniRouteUrl/Model/VisionModel` into the `omniroute` entry.
3. Fold `localLlmUrl/Model` into the `relais` entry (blank URL keeps the
   `http://127.0.0.1:8080` default, matching today's behaviour).
4. `activeProviderId` = `omniroute` if `llmBackend === "omniroute"`, else
   `relais`. An `llmBackend` of `"on-device"` maps to `relais` — it never had an
   implementation, so anyone holding that value was already falling through.
5. `visionProviderId` = `omniroute` when that entry has a `visionModel`, else
   null.
6. Re-file `carnet.omniroute.apikey` -> `carnet.llm.key.omniroute` and
   `carnet.localllm.apikey` -> `carnet.llm.key.relais`, then delete the old
   entries only after the new writes resolve.

Migration must be idempotent and must not lose a key if interrupted between
steps — write new, verify, then delete old. `settings.test.ts` already has a
migration-testing pattern from the B1 chat/vision split (`:177-264`) to follow.

## Vision routing

`enrichSharedImage`, `enrichSharedLink`-with-image, and `ocrCardViaVision`
resolve their provider as:

1. active entry's `visionModel` if non-empty -> use the active entry
2. else `visionProviderId` entry, if set and it has a `visionModel`
3. else throw the existing not-configured error

Step 3 is today's behaviour: callers already degrade to stub + banner. The
fallback adds a rung above it and introduces no new failure mode.

This is the "hybrid vision routing" the on-device PRD
(`.claude/PRPs/prds/on-device-backend.prd.md`) already recommends — a text-only
local model paired with cloud vision.

## UI

A new `components/LlmProviderSection.tsx`, not more lines in
`SettingsScreen.tsx` (just brought 987 -> 750 by #90):

- A dropdown listing presets then custom entries, showing the active one.
- The active entry's fields inline: base URL, API key (secure, with the existing
  configured/clear affordance), model, optional vision model.
- The model fields keep the existing `/v1/models` browser
  (`ModelBrowserModal` + `lib/modelBrowser.ts`), which is already parameterized
  by base URL and key, so it works unchanged for any provider.
- Add / rename / delete for custom entries. Presets cannot be deleted.
- A separate "Use for vision" selector, shown with a one-line explanation of
  when it applies.
- The existing health-check affordance is kept per entry.

Styling follows `DESIGN.md` tokens; no new visual language.

## Error handling

Unchanged in kind. `llmClient.ts` keeps `omniroute.ts`'s generalized error
predicates (`isNotConfiguredError`, `isPermanentError`), which already classify
via the shared `HttpError` base and therefore already work for any backend —
that generalization landed specifically so a second backend could reuse them.

One addition: a provider with a blank `baseUrl` raises not-configured, so a
fresh install that selects OpenAI without pasting a key gets the same clear
banner as a blank OmniRoute URL does today (the bug fixed in #29).

## Testing

- `llmProviders.test.ts` — resolution, validation, add/remove, preset editing.
  Pure, no mocks.
- `llmClient.test.ts` — the retargeted omniroute + localLlm suites. These must
  pass essentially unchanged through the merge; that is the evidence the merge
  is behaviour-preserving.
- `settings.test.ts` — migration: each `llmBackend` value, blank local URL,
  key re-filing, idempotency, and interrupted-migration key safety.
- `providerKeys.test.ts` — key namespacing and delete-with-provider.
- `SettingsScreen.test.tsx` — the section renders, switching the dropdown
  changes the primary, deleting a custom entry removes its key.
- `dispatcher.test.ts` — the fallback chain: an unreachable primary retries the
  fallback; a **permanent** 4xx does NOT (the important negative case — falling
  back there would mask a bad key); both unreachable falls into the queue; no
  fallback configured behaves exactly as today.

Mutation-test the fallback predicate specifically. The three prior refactors in
this session each shipped a test that passed for the wrong reason, and
"retries on the wrong error class" is precisely the kind of bug an
assert-on-mocks test misses.

Gates: `typecheck`, `lint`, full vitest, `verify:capture-flow`.

**Frontmatter is not touched by this change** — enrichment returns markdown
that existing writer/frontmatter code serializes unchanged. `verify:capture-flow`
guards that.

## Phasing

Five commits, in this order, each independently green. The ordering is the main
risk control: the blocking prerequisite is settled first against a real device,
then the riskiest refactor lands alone against the existing tests with no UI to
confuse the diff.

0. **`plugins/withCleartextLocal.js`.** LAN cleartext is verified blocked on
   release builds (see above); loopback is verified working. Ship a network
   security config permitting cleartext to RFC1918 only, reconcile
   `isAllowedPlaintextHost` (missing `172.16/12`), and make a
   platform-blocked connection distinguishable from "server down" in the
   health-check UI. **Independent of everything below** — it fixes a live bug
   for every LAN user today and the rest of the design does not wait on it.
1. **Merge the client.** `omniroute.ts` + `localLlm.ts` -> `llmClient.ts`,
   parameterized by a `ProviderConfig` the caller supplies. `dispatcher.ts`
   builds that config from today's settings fields, so **no settings change and
   no user-visible change**. Both existing suites are retargeted and must pass
   essentially unchanged — that is the evidence the merge is faithful.
2. **Provider list + migration.** Add `llmProviders.ts`, `providerKeys.ts`, the
   new settings fields, and the migration. `dispatcher.ts` switches to resolving
   a provider. Still no UI: the primary comes from migrated settings, so
   behaviour is unchanged for an existing install.
3. **Fallback chain + marker.** `fallbackProviderId`, the unreachable-only retry,
   the frontmatter provenance marker, and surfacing it in `RecentDetailScreen`
   next to the existing Re-enrich action.
4. **UI.** `LlmProviderSection.tsx`, the dropdown, add/edit/delete, the fallback
   and vision selectors. Only now does anything change in Settings.

A reviewer can check "did enrichment change?" against commit 1 alone, and "did
the vault bytes change?" against commit 3 alone.

## Risks

| Risk | Mitigation |
|---|---|
| The client merge silently changes enrichment output for one backend | Retarget both existing suites at `llmClient.ts` rather than rewriting them; they were written against the old behaviour. Merge behaviour-preserving FIRST, in its own commit, before any UI. |
| Migration loses an API key | Write-verify-delete ordering; idempotent; explicit interrupted-migration test. |
| Users pointed at a provider whose model list is huge (OpenRouter) | The model browser already filters; it is unchanged. |
| Scope creep into per-capture provider choice | Explicit non-goal. |

## Issue disposition

This design resolves the remaining LLM cluster on a different basis than the
issues' original text, which assumed native on-device inference:

- **#83** (local backend module) — satisfied, by a different mechanism than its
  text assumed. `localLlm.ts` shipped in PR #105 and is generalized here. Its AC
  named "native module wiring" and "MediaPipe vs ExecuTorch"; on-device
  inference is instead delivered by Relais on the handset. The AC's real intent
  — enrichment with no internet — is met and is tested by #85's airplane-mode
  run.
- **#84** (model provisioning: download, integrity, storage) — not applicable.
  Relais owns the model on whichever host it runs; Carnet never downloads one.
- **#85** (backend switch UX + offline capture E2E) — **its airplane-mode
  acceptance criterion stands as written** and is the acceptance run for this
  design, performed with Relais on the handset and `relais` as the fallback
  provider. Loopback cleartext is verified working on a release build, so
  nothing gates this. The UX half is widened by the provider list.
- **#78 / #75** — close once the above are dispositioned.

Each should be closed with a comment recording this reasoning, not silently.
