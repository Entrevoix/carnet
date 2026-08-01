/**
 * Single-flight write chain for the LLM provider identity fields
 * (`llmProviders`/`activeProviderId`/`nextCustomSeq`/`fallbackProviderId`/
 * `visionProviderId`) — extracted from `components/LlmProviderSection.tsx`
 * so the CRITICAL lost-update fix has its own direct test coverage and the
 * component file stays under this repo's file-size norm.
 *
 * The bug this exists to prevent: every identity-changing handler in
 * LlmProviderSection does a read-modify-write (`getSettings()` then
 * `savePersistedOnly({...current, ...patch})`). If two such writes are
 * independent async calls, they can interleave read → read → write → write
 * — the LAST write's snapshot was taken BEFORE the first write landed, so
 * it silently clobbers the first write's change. Reproduced during review:
 * typing an API key for OmniRoute, picking OpenAI as active moments later,
 * then tapping Save — the persisted `activeProviderId` reverted to
 * `omniroute` while the header still showed OpenAI, so every capture went
 * to the wrong provider (with that provider's key) until the app restarted.
 *
 * The fix: every write is chained onto the SAME promise
 * (`writeChainRef.current`), so a write only starts reading settings once
 * the write queued immediately before it has fully landed. Each write
 * therefore always builds on the true, immediately-preceding persisted
 * state — never a stale snapshot. A rejected write does not wedge the
 * chain: the next queued write still runs, against a fresh read, instead of
 * inheriting a permanently-broken chain.
 *
 * `writing` (derived from a pending-write counter, not a boolean, since more
 * than one write can legitimately be queued at once) lets the caller disable
 * Save and the picker rows while a write is in flight — the UI-level half of
 * the fix, so the user can't start an overlapping write in the first place.
 */
import { useEffect, useRef, useState } from "react";

import { getSettings, savePersistedOnly, type Settings } from "./settings";

export type IdentityPatch = Partial<
  Pick<
    Settings,
    | "llmProviders"
    | "activeProviderId"
    | "nextCustomSeq"
    | "fallbackProviderId"
    | "visionProviderId"
  >
>;

export interface ProviderWriteChain {
  /** Queue a read-modify-write of the identity fields. Resolves/rejects
   * once THIS write (not the whole chain) has landed. */
  persistIdentity: (patch: IdentityPatch) => Promise<void>;
  /** True while at least one queued write has not yet settled. */
  writing: boolean;
}

export function useProviderWriteChain(): ProviderWriteChain {
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function persistIdentity(patch: IdentityPatch): Promise<void> {
    if (mountedRef.current) setPendingWrites((c) => c + 1);
    const next = writeChainRef.current.then(async () => {
      const current = await getSettings();
      await savePersistedOnly({ ...current, ...patch });
    });
    writeChainRef.current = next.catch(() => undefined);
    return next.finally(() => {
      if (mountedRef.current) setPendingWrites((c) => c - 1);
    });
  }

  return { persistIdentity, writing: pendingWrites > 0 };
}
