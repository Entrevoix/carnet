# Data Model — vault & local stores
<!-- Generated: 2026-06-11 | Files scanned: ~41 | Token estimate: ~600 -->

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
(flow + block) + `normalizeTag`; location stored as `location: "lat,lon"`.
Byte-exact `split` / `extract` / `strip` / `rewriteFrontmatterField` preserve header bytes
(critical: same-day journal append must merge per-entry metadata into the day file).

## Shared types — `packages/shared/src`
`types.ts`: `IdeaNote` `IdeaStatus` (`IDEA_STATUSES`) `JournalEntry` `PersonNote`
`CaptureResponse` `CaptureStatus`. `markdown.ts`: `parseStatusFromMarkdown` `deriveTitle`.

## Local stores (AsyncStorage)
- Offline queue rows — `lib/queue.ts`
- Settings / feature flags — `lib/settings.ts`
- Tag-index cache — `lib/vault.ts`

## Tag index — `lib/vault.ts` (246 ln)
`buildTagIndex` (scans Ideas/Journal/People, bounded concurrency, cached) ·
`getTagIndex` (cache-first) · `suggestTags` · `tagsForNote`.
