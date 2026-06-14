# Data Model — vault & local stores
<!-- Generated: 2026-06-14 | Files scanned: ~53 | Token estimate: ~640 -->

**No SQL database.** Data = Markdown files + binaries in the Syncthing-synced vault,
plus a few AsyncStorage keys on the device.

## Vault layout  (`/Documents/carnet` on device ↔ `~/Obsidian/Carnet` on workstation)
```
Ideas/{slug}.md          IdeaNote        (status in frontmatter)
Journal/YYYY-MM-DD.md     JournalEntry    (one day file; same-day captures appended)
People/F-L.md             PersonNote
Photos/{slug}.jpg         image binaries
Attachments/…             paired files (embedded from notes via ../Subdir/file)
```

## Frontmatter — `lib/frontmatter.ts` (347 ln)
`parseFrontmatter` `upsertFrontmatterField`; tags `getFrontmatterTags` / `setFrontmatterTags`
(flow + block) + `normalizeTag`; location stored as `location: "lat,lon"`;
`karakeepId` stamped on export for idempotent re-export.
Byte-exact `split` / `extract` / `strip` / `rewriteFrontmatterField` preserve header bytes
(critical: same-day journal append must merge per-entry metadata into the day file).

## Shared types — `packages/shared/src` (index 14 · markdown 41 · types 47 ln)
`types.ts`: `IdeaNote` `IdeaStatus` (`IDEA_STATUSES`) `JournalEntry` `PersonNote`
`CaptureResponse` `CaptureStatus`. `markdown.ts`: `parseStatusFromMarkdown` `deriveTitle`.

## Local stores (AsyncStorage)
- Offline queue rows — `lib/queue.ts` (`carnet:queue:v1`)
- Settings / feature flags — `lib/settings.ts` (API keys in SecureStore)
- Tag-index cache — `lib/vault.ts`
- Karakeep per-bookmark pushed-asset record — `lib/karakeepAssetSync.ts` (`carnet:karakeep-assets:v1:<id>`)
- STT-onboarding one-shot flag — `voice/sttOnboarding.ts` (`stt_onboarding_prompted_v1`)

## Tag index — `lib/vault.ts` (246 ln)
`buildTagIndex` (scans Ideas/Journal/People, bounded concurrency, cached) ·
`getTagIndex` (cache-first) · `suggestTags` · `tagsForNote`.
