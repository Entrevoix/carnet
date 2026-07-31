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

## Non-goals

- **On-device native inference.** No MediaPipe/ExecuTorch/llama.cpp, no `.so`,
  no model download. "Local" means an OpenAI-compatible HTTP host (Relais by
  default), which is what the user actually wants. This closes out #83/#84 on a
  different basis than their original text assumed — see "Issue disposition".
- Per-capture provider override. One active provider, plus one optional vision
  fallback.
- Streaming responses, cost tracking, provider-specific auth schemes beyond a
  bearer token.

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
llmProviders: LlmProvider[];      // presets (possibly edited) + custom entries
activeProviderId: string;         // which one serves captures
visionProviderId: string | null;  // fallback when the active entry has no visionModel
```

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
  changes the active entry, deleting a custom entry removes its key.

Gates: `typecheck`, `lint`, full vitest, `verify:capture-flow`.

**Frontmatter is not touched by this change** — enrichment returns markdown
that existing writer/frontmatter code serializes unchanged. `verify:capture-flow`
guards that.

## Phasing

Three commits, in this order, each independently green. The ordering is the
main risk control: the riskiest change lands first, alone, against the existing
tests, with no UI to confuse the diff.

1. **Merge the client.** `omniroute.ts` + `localLlm.ts` -> `llmClient.ts`,
   parameterized by a `ProviderConfig` the caller supplies. `dispatcher.ts`
   builds that config from today's settings fields, so **no settings change and
   no user-visible change**. Both existing suites are retargeted and must pass
   essentially unchanged — that is the evidence the merge is faithful.
2. **Provider list + migration.** Add `llmProviders.ts`, `providerKeys.ts`, the
   new settings fields, and the migration. `dispatcher.ts` switches to resolving
   a provider. Still no UI: the active provider comes from migrated settings, so
   behaviour is unchanged for an existing install.
3. **UI.** `LlmProviderSection.tsx`, the dropdown, add/edit/delete, the vision
   selector. Only now does anything change for the user.

A reviewer can therefore check "did enrichment change?" against commit 1 alone.

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

- **#83** (local backend module) — satisfied. `localLlm.ts` shipped in PR #105
  and is generalized here. Its AC ("native module wiring", "MediaPipe vs
  ExecuTorch", "zero network calls with a model file present") described
  on-device inference, which is now an explicit non-goal.
- **#84** (model provisioning: download, integrity, storage) — not applicable.
  The provider hosts the model; Carnet never downloads one.
- **#85** (backend switch UX + offline capture E2E) — superseded and widened by
  this design. Its airplane-mode AC only holds if the provider runs on the
  handset; for a LAN host the honest test is "no internet, LAN reachable".
- **#78 / #75** — close once the above are dispositioned.

Each should be closed with a comment recording this reasoning, not silently.
