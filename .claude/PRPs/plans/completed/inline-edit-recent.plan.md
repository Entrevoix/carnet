# Plan: Inline edit a recent capture (slate #6)

## Summary
RecentDetail gets an Edit mode. Tap the pencil → the rendered markdown swaps for a multiline TextInput showing the full note content (frontmatter + body). Save persists via `updateNote`, re-derives the recents title if the H1 changed, and updates AsyncStorage. Cancel discards. A hard unsaved-changes guard fires on back-navigation. Closes the read/write loop for recents — no more Obsidian detour to fix a typo.

## User Story
As a carnet user who just captured a note with a typo or wrong tags,
I want to fix it from inside carnet,
So that I don't have to switch to Obsidian just to rename or tweak two characters.

## Problem → Solution
**Current:** RecentDetail is read-only. Every edit requires opening Obsidian, navigating to the file, fixing, saving. On mobile that's 6+ taps and an app switch for a 1-character fix.

**Desired:** Tap Edit → fix → tap Save. 3 taps, no app switch. Re-renders the markdown view immediately so the user sees the result.

## Metadata
- **Complexity:** Medium
- **Source PRD:** N/A — slate #6 from the v0.3 feature menu
- **PRD Phase:** v0.3
- **Estimated Files:** 1 new helper + 3 modified + 1 test
- **Confidence Score:** 9/10 — uses existing `updateNote` + `deriveTitle` + AsyncStorage primitives. UX is standard mobile edit-mode pattern.

---

## UX Design

### Flow
```
RecentDetail (view mode today)         RecentDetail (after this PR)
┌────────────────────────────┐        ┌────────────────────────────┐
│ Audio note: foo.m4a        │        │ Audio note: foo.m4a        │
│ Audio · 5 min ago          │        │ Audio · 5 min ago          │
│                            │        │                            │
│ ## File                    │        │ ## File                    │
│ [foo.m4a](../Audio/...)    │        │ [foo.m4a](../Audio/...)    │
│                            │        │                            │
│ ## Context                 │        │ ## Context                 │
│ (none provided)            │        │ (none provided)            │
│                            │        │                            │
│ [Transcribe] [Delete]      │        │ [Edit] [Transcribe] [Delete]│
└────────────────────────────┘        └────────────────────────────┘
                                                │
                                                ▼ tap Edit
                                      ┌────────────────────────────┐
                                      │ Editing                    │
                                      │ ┌────────────────────────┐ │
                                      │ │ ---                    │ │
                                      │ │ kind: shared-audio     │ │
                                      │ │ ---                    │ │
                                      │ │ # Audio note: foo.m4a  │ │
                                      │ │ ## File ...            │ │
                                      │ └────────────────────────┘ │
                                      │      [Cancel]  [Save]      │
                                      └────────────────────────────┘
                                                │
                                                ▼ tap Save
                                      Back to view mode with new content
                                      (recents list title updates if H1 changed)
```

### Interaction changes
| Touchpoint | Before | After |
|---|---|---|
| RecentDetail Card.Actions | `[Re-enrich?] [Transcribe?] [Delete]` | `[Edit] [Re-enrich?] [Transcribe?] [Delete]` |
| Edit mode | doesn't exist | Multiline TextInput (monospace) + Save/Cancel; markdown render hidden |
| Back navigation with dirty draft | navigates away silently | hard dialog: "Discard changes?" with Keep editing / Discard |
| Recents list title | cached at capture time, stale after H1 edit | re-derived after save; updates AsyncStorage history record |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `apps/mobile/src/screens/RecentDetailScreen.tsx` | all | The screen being extended. Reuse existing ref-guard pattern + Card.Actions row + Dialog/Portal shape. |
| P0 | `apps/mobile/src/lib/writer.ts` | `updateNote` ~648 | Existing function that overwrites a note file. Used for save. |
| P0 | `apps/mobile/src/lib/storage.ts` | all | Need a new `updateCaptureTitle(id, title)` helper. |
| P0 | `packages/shared/src/markdown.ts` | `deriveTitle` | Pulls the H1 (or first sensible line) from markdown body. Already used by ShareReceive + PhotoCapture. |
| P1 | `apps/mobile/src/screens/ShareReceiveScreen.tsx` | save() flow | Reference for how title derivation feeds into recordCapture. Same logic, applied at edit-save time. |

---

## Discovery Table

| Category | Where | Pattern |
|---|---|---|
| Markdown render | `RecentDetailScreen.tsx` Card body | `<Markdown>{stripFrontmatter(body)}</Markdown>` — hide when editing |
| Ref-guard pattern | RecentDetailScreen — `deletingRef`, `reEnrichingRef`, `transcribingRef` | New `savingEditRef` follows same shape |
| Dialog confirm | RecentDetailScreen Portal/Dialog for Delete | Reuse for "Discard changes?" confirm |
| `updateNote(filepath, markdown)` | writer.ts:648 | Already serialized via `_writeChain` per-filepath; safe to call from edit save |
| `deriveTitle(markdown)` | shared/markdown.ts | Used by share + photo capture today; reuse for re-derivation post-edit |
| Navigation beforeRemove | RN Nav docs | `navigation.addListener('beforeRemove', handler)` — preventDefault + show dialog when dirty |

---

## Patterns to Mirror

### EDIT_STATE_MACHINE (new in RecentDetailScreen)
```tsx
const [editMode, setEditMode] = useState(false);
const [draft, setDraft] = useState<string>("");
const [discardVisible, setDiscardVisible] = useState(false);
const savingEditRef = useRef(false);

// Computed: did the user actually change anything?
const isDirty = editMode && draft !== body;

const enterEdit = () => {
  setDraft(body);
  setEditMode(true);
};

const cancelEdit = () => {
  if (draft !== body) {
    setDiscardVisible(true);
    return;
  }
  setEditMode(false);
};

const confirmDiscard = () => {
  setDiscardVisible(false);
  setEditMode(false);
  setDraft("");
};

const handleSaveEdit = useCallback(async () => {
  if (savingEditRef.current) return;
  savingEditRef.current = true;
  try {
    await updateNote(entry.filepath, draft);
    setBody(draft);
    // Re-derive title from the new content. If it changed, propagate to
    // the recents history so the Home list reflects the edit.
    const newTitle = deriveTitle(draft) || entry.title;
    if (newTitle !== entry.title) {
      await updateCaptureTitle(entry.id, newTitle);
    }
    setEditMode(false);
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    setEditError(reason);
  } finally {
    savingEditRef.current = false;
  }
}, [draft, entry.filepath, entry.id, entry.title]);
```

### BEFOREREMOVE_GUARD (RN Navigation)
```tsx
useEffect(() => {
  const unsub = navigation.addListener("beforeRemove", (e) => {
    if (!isDirty) return;
    e.preventDefault();
    setDiscardVisible(true);
    // The discard dialog's "Discard" action will manually navigate away
    // after clearing the dirty flag. "Keep editing" just dismisses.
    pendingNavActionRef.current = e.data.action;
  });
  return unsub;
}, [navigation, isDirty]);

// In confirmDiscard: setEditMode(false) then navigation.dispatch(pendingNavActionRef.current)
```

### UPDATE_CAPTURE_TITLE (new in storage.ts)
```ts
/**
 * Update the title of a single capture entry in place. Used when the user
 * edits the H1 of a note from inside carnet — keeps the recents list in
 * sync with the file content. Unknown ids are silently ignored. Skips the
 * write if the existing title already matches to avoid an empty round-trip.
 */
export async function updateCaptureTitle(
  id: string,
  title: string,
): Promise<void> {
  const existing = await getRecentCaptures();
  const idx = existing.findIndex((e) => e.id === id);
  if (idx === -1) return;
  if (existing[idx].title === title) return;
  const next = [...existing];
  next[idx] = { ...next[idx], title };
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(next));
}
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `apps/mobile/src/lib/storage.ts` | UPDATE | Add `updateCaptureTitle(id, title)` |
| `apps/mobile/src/screens/RecentDetailScreen.tsx` | UPDATE | Edit mode state machine + TextInput + Save/Cancel + beforeRemove guard |
| `apps/mobile/src/lib/storage.test.ts` | UPDATE | Tests for `updateCaptureTitle` (happy, unknown-id, no-op-when-same) |

## NOT Building
- **File rename / filepath change** — would require moveFile in writer.ts + history filepath patch + paired-binary reference updates. Real scope. Defer.
- **Block-level edit per section** — separate edit per `## ` block. Better mobile UX but real complexity (markdown AST parsing, section-edit dialogs). Defer.
- **Live preview while editing** — split-pane editor with rendered preview underneath. Doubles the visual surface, real work. The user can always save + view to see the result. Defer.
- **Edit history / undo beyond the OS TextInput buffer** — RN TextInput has its own keyboard-level undo. No app-level edit log.
- **Structured fields for frontmatter** — separate inputs for kind/tags/etc. Less footgun-y but limits power. Plain TextInput matches the "carnet is intake-only, Obsidian is the editor" thesis while removing the most annoying friction.
- **Re-enrich / Transcribe on edited content** — the existing Re-enrich (vision) and Transcribe (Whisper) buttons work off the paired binary, not the markdown body. Editing the body doesn't change what those buttons do. Documented in code.

---

## Step-by-Step Tasks

### Task 1: Add `updateCaptureTitle` to storage.ts
- **ACTION:** Edit `apps/mobile/src/lib/storage.ts`.
- **IMPLEMENT:** Per `UPDATE_CAPTURE_TITLE` above. Place near `removeManyFromHistory` since both mutate the history array.
- **GOTCHA:**
  - The no-op-when-same check prevents AsyncStorage churn when the user edits the body but not the H1 (the most common case).
  - Unknown ids silently ignored — same shape as `removeFromHistory`.

### Task 2: Wire Edit mode in RecentDetailScreen
- **ACTION:** Edit `apps/mobile/src/screens/RecentDetailScreen.tsx`.
- **IMPLEMENT:**
  1. Add imports: `TextInput` from react-native-paper, `updateCaptureTitle` from storage, `deriveTitle` from `@carnet/shared`.
  2. Add state: `editMode`, `draft`, `editError`, `discardVisible`, `savingEditRef`, `pendingNavActionRef`.
  3. Add handlers: `enterEdit`, `cancelEdit`, `confirmDiscard`, `keepEditing`, `handleSaveEdit`.
  4. Add `useEffect` with `navigation.addListener("beforeRemove", ...)` for unsaved-changes guard.
  5. In the render: when `editMode`, render TextInput + Save/Cancel buttons instead of the Markdown body; otherwise render as today.
  6. Add Edit button to `Card.Actions` row (before Re-enrich/Transcribe).
  7. Add second Portal/Dialog for the discard confirm.
- **MIRROR:** Existing ref-guard handlers (handleDelete, handleReEnrich, handleTranscribe) for shape; existing Portal/Dialog for the discard confirm.
- **GOTCHA:**
  - `beforeRemove` listener captures `isDirty` via closure — must re-subscribe when `isDirty` changes (effect dep). Otherwise stale closure either always-blocks or never-blocks.
  - When the user taps Save successfully, `editMode` flips to false BEFORE the user can navigate back, so the beforeRemove handler sees `isDirty=false` and lets navigation through cleanly. No special case needed.
  - The TextInput should be `multiline numberOfLines` large enough to feel like an editor (10+), use `fontFamily: "monospace"` so the markdown's leading-space-sensitivity is visible.
  - Hide the body-rendering Card during edit so the user isn't confused by a stale preview.

### Task 3: Tests for `updateCaptureTitle`
- **ACTION:** Edit `apps/mobile/src/lib/storage.test.ts`.
- **IMPLEMENT:** 3 cases: (a) updates the matching id, leaves others alone; (b) silently ignores unknown id (no write); (c) no-op when new title equals existing.
- **VALIDATE:** vitest run shows 12+3 = 15 storage tests.

### Task 4: Validate
- **ACTION:** Run `npm -w @carnet/mobile run typecheck` + `npm -w @carnet/mobile run test`.
- **EXPECT:** 0 type errors. 204 existing + 3 new = 207 tests pass.

---

## Testing Strategy

### Unit Tests
3 new in `storage.test.ts` for `updateCaptureTitle`. The screen wiring is on-device territory (RN navigation listeners + TextInput state aren't usefully unit-tested without heavy mocking).

### Edge Cases Checklist
- [ ] Tap Edit → TextInput appears with full note content (frontmatter + body)
- [ ] Edit body → tap Save → body in view mode updates immediately
- [ ] Edit H1 → tap Save → recents list title updates on Home
- [ ] Edit body without changing H1 → no AsyncStorage write (no-op path)
- [ ] Tap Cancel with no changes → exits edit mode silently
- [ ] Tap Cancel with changes → discard dialog appears → tap Keep editing → stays in edit mode with draft preserved
- [ ] Tap Cancel with changes → tap Discard → exits edit mode, body unchanged
- [ ] Edit + tap Back button → discard dialog appears
- [ ] Discard dialog → tap Discard → navigates back, original body intact in storage
- [ ] Save → writer throws (SAF perm revoked, disk full) → editError banner surfaces, draft preserved
- [ ] Edit a `kind: shared-audio` note → save → Transcribe button still gated correctly (kind unchanged)
- [ ] Edit and corrupt the YAML frontmatter → save → file written as-is (no validation; same as Obsidian)
- [ ] Regression: existing Delete / Re-enrich / Transcribe buttons still work in view mode

---

## Validation Commands

### Static + tests
```bash
npm -w @carnet/mobile run typecheck
npm -w @carnet/mobile run test
```
EXPECT: 0 type errors; 207/207 pass.

### Manual on-device
```bash
cd apps/mobile && npm run android
```

---

## Acceptance Criteria
- [ ] Edit button visible on every RecentDetail (no kind gate)
- [ ] Tap Edit → TextInput with full content, Save/Cancel buttons
- [ ] Save persists via `updateNote`, updates rendered body, re-derives title
- [ ] Cancel with no changes exits silently; with changes shows discard dialog
- [ ] Back-navigation with dirty draft shows discard dialog
- [ ] 0 type errors; 207 tests pass

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Concurrent Obsidian edit + carnet edit → last-write-wins data loss | Low | User loses one edit | Standard text-editor semantics. Same risk as any sync setup. Accept. |
| Very large note (~100KB+ transcript) lags TextInput on low-end Android | Medium | Sluggish typing | Document as known limit. For transcripts, users typically edit in Obsidian anyway. Future: streaming text-editor lib. |
| beforeRemove stale-closure misses isDirty changes | Medium without test | Discard dialog either never fires or always fires | Effect deps include `isDirty`; verified pattern from RN Nav docs. |
| User corrupts YAML frontmatter → enrich-time prompts read garbage | Low | One bad note, recoverable | Same as Obsidian. We don't validate; the user owns the consequences. |
| AsyncStorage race between Save and a concurrent removeManyFromHistory call | Very low | Title write clobbers a delete | `updateCaptureTitle` is read-modify-write; not transactional. If a delete fires in between, the deleted entry comes back with a new title. In practice the Home screen is the only other writer and it's not active while RecentDetail is on screen. Accept. |
| The Edit button is shown when the note is missing (banner state) | Low | User taps Edit, gets empty TextInput | Disable Edit when `missing === true`, same pattern as Delete/Transcribe. |

## Notes
- This PR closes the read/write loop. After it merges, carnet is a full standalone capture+edit surface for the recents window. Older notes still require Obsidian (no global vault browse — intentional per the "intake-only" thesis).
- The Edit button gets first position in Card.Actions because it's the most-likely action on a captured note that turned out wrong; Delete keeps the rightmost position as the destructive action.
- A future PR can add file-rename via a second Edit field for the filename. Out of scope here.
