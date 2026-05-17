---
pr: 3
title: "carnet v0.2: drop navetted, route via OmniRoute, Syncthing-backed"
author: bearyjd
branch_head: feat/v0.2-omniroute-migration
branch_base: main
reviewed: 2026-05-17
decision: COMMENT (self-review)
---

# PR Review: #3 — carnet v0.2: drop navetted, route via OmniRoute, Syncthing-backed

**Author**: bearyjd
**Branch**: feat/v0.2-omniroute-migration → main
**Files changed**: 35 (+2758 / −1374)
**Decision**: COMMENT — self-review (GitHub disallows approving one's own PR). Findings already addressed inline; review is a record of what was caught.

## Summary

Reviews v0.2 as it stands at HEAD. The migration deletes the navetted WS + HMAC + Claude-CLI-subprocess path and replaces it with a mobile-first OmniRoute HTTPS client + local-filesystem markdown writer + offline-first SQLite capture queue + Syncthing-based sync. Architecture is coherent, validation clean.

In-flight review during construction (this conversation) found 11 issues across P0/P1/P2, then dispatched a security review that found 8 more (3 HIGH / 3 MEDIUM / 2 LOW). All 19 are addressed in the trailing three `fix:` commits (`9c6e3e1`, `f26f4cc`, `8272aad`) except offline-queue encryption, which is deferred to v0.3 with explicit rationale in TODO.md.

## Findings (status at HEAD)

### CRITICAL

None.

### HIGH (all addressed)

1. **Missing `model` field in OmniRoute request body** — fixed in `9c6e3e1` (`omniroute.ts:120`). Configurable via `omniRouteModel` setting, default `gpt-4o-mini`.
2. **drainQueue had no single-flight guard** — fixed in `f26f4cc` (`queue.ts:113`). Module-level `_draining` flag; covered by a new vitest.
3. **All exceptions routed to offline queue** — fixed in `f26f4cc` (`CaptureScreen.tsx:97`). `handleCaptureError` classifies via `isPermanentError`: 4xx surfaces the actual error; network/5xx queues silently.
4. **No HTTPS enforcement on OmniRoute URL** — fixed in `9c6e3e1` (`omniroute.ts:91`). `https://` is required; `http://localhost` / `127.0.0.1` / `10.x` allowed for dev.
5. **PII in offline queue plaintext** — DEFERRED to v0.3 with explicit rationale in TODO.md. Threat model is rooted device / adb pull / privileged-app exfil; defense-in-depth for the solo-developer use case, blocker for any non-developer rollout.
6. **Unescaped user input in prompts (injection risk)** — fixed in `9c6e3e1` (`prompts.ts`). User-supplied text wrapped in `<USER_INPUT>...</USER_INPUT>` delimiters; system prompt instructs the model to treat content as data.

### MEDIUM (all addressed)

7. **writePerson silently overwriting** — fixed in `f26f4cc` (`writer.ts:281`). Collision dance (-2, -3, ...) like writeIdea.
8. **No fetch timeout** — fixed in `9c6e3e1` (`omniroute.ts:115`). 60s `AbortController`.
9. **appendJournal read-then-write race** — fixed in `f26f4cc` (`writer.ts:212`). Per-filepath promise chain via `serialize()` helper.
10. **UTC date in `todayIso` shifting late-evening captures** — fixed in `9c6e3e1` (`prompts.ts:24`) and `f26f4cc` (`CaptureScreen.tsx:31`). Local-date components.
11. **Legacy SecureStore token cleanup hole** — fixed in `9c6e3e1` (`settings.ts:89`). `purgeLegacySecretsOnce()` runs unconditionally on first v0.2 boot.
12. **Raw error message leak (Bearer tokens)** — fixed in `9c6e3e1` (`omniroute.ts:78`) and `f26f4cc` (`queue.ts:20`). `sanitizeError()` strips Bearer / Authorization fragments before propagation or persistence.

### LOW (all addressed)

13. **personFilename not path-safe (defense in depth)** — fixed in `f26f4cc` (`writer.ts:75`). Strict allowlist regex `^[A-Za-z0-9'\-]+$`.
14. **API key kept in React state in plaintext** — fixed in `9c6e3e1` (`SettingsScreen.tsx:32`). Write-only field: shows `•••• configurée` placeholder, never re-reads the key into state for display.
15. **No system role in prompts** — fixed in `9c6e3e1` (`prompts.ts`). Builders return `{system, user}` pairs.
16. **Dead code in settings.ts** — fixed in `9c6e3e1`. `getClientId`, `CLIENT_ID_KEY`, navetted-hello references removed.
17. **`extractNameFromMarkdown` DRY** — fixed in `f26f4cc`. Moved from `CaptureScreen.tsx` to `writer.ts`, exported, tested.
18. **No console.log audit** — clean (grep on the diff confirms zero `console.log/error/warn/info/debug` additions).
19. **Stale orphaned imports after delete** — confirmed clean. IDE diagnostics showing references to `client.ts` / `useConnectionStatus.ts` / `PairScreen` are stale cache (files removed on disk, typecheck clean).

## Validation Results

| Check | Result |
|---|---|
| Type check (`@carnet/mobile`) | Pass |
| Type check (`@carnet/shared`) | Pass |
| Build (`@carnet/shared`) | Pass |
| Tests (`@carnet/mobile`) | Pass — 50/50 (was 0 in v0.1) |
| Tests (`@carnet/shared`) | Pass — 0 test files (intentional; client.test.ts deleted, surface moved to mobile workspace) |
| Lint | n/a (project has no ESLint script configured) |

## Files Reviewed

Source — added:
- `apps/mobile/src/lib/omniroute.ts`
- `apps/mobile/src/lib/omniroute.test.ts`
- `apps/mobile/src/lib/prompts.ts`
- `apps/mobile/src/lib/queue.ts`
- `apps/mobile/src/lib/queue.test.ts`
- `apps/mobile/src/lib/writer.ts`
- `apps/mobile/src/lib/writer.test.ts`
- `apps/mobile/test/__stubs__/expo-haptics.ts`
- `apps/mobile/test/__stubs__/expo-sqlite.ts`
- `apps/mobile/vitest.config.ts`
- `docs/sync-setup.md`

Source — modified:
- `apps/mobile/App.tsx`
- `apps/mobile/src/lib/settings.ts`
- `apps/mobile/src/screens/CaptureScreen.tsx`
- `apps/mobile/src/screens/HomeScreen.tsx`
- `apps/mobile/src/screens/SettingsScreen.tsx`
- `packages/shared/src/types.ts`
- `packages/shared/src/index.ts`
- `package.json`, `package-lock.json`
- `packages/shared/package.json`, `packages/shared/vitest.config.ts`
- `README.md`
- `TODO.md`

Source — deleted:
- `apps/mobile/src/components/QrScanner.tsx`
- `apps/mobile/src/components/StatusPill.tsx`
- `apps/mobile/src/lib/client.ts`
- `apps/mobile/src/lib/useConnectionStatus.ts`
- `apps/mobile/src/screens/PairScreen.tsx`
- `packages/shared/src/client.ts`
- `packages/shared/src/client.test.ts`
- `packages/shared/src/messages.ts`

## Outstanding (separate work, not blocking merge)

- **Phase 10** — navette repo cleanup. Delete `src/capture/` and `[carnet]` config block in the sibling navette repo.
- **Real-world OmniRoute probe** — first live call confirms or refutes the OpenAI-compatible schema assumption.
- **Real-world Syncthing round-trip** — set up per `docs/sync-setup.md`, capture an idea, watch it appear in workstation Obsidian.
- **v0.3 deferrals** (captured in TODO.md):
  - On-device Gemma backend (pluggable alongside OmniRoute)
  - Encrypted offline queue payloads at rest
  - Mobile browse + search, auto-capture surfaces, retrospective query, card auto-detection, cross-capture linking
  - Whisper → OmniRoute consolidation pending OmniRoute audio support investigation
  - Desktop app fate
