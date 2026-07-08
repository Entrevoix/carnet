---
created: 2026-07-02T14:30:00Z
status: seed
tags: [i18n]
---

# 日本語のアイデア

slugify() is ASCII-only (see TODO.md "Slugify Unicode edge cases") — a
non-Latin H1 like this one folds to an empty string, so callers must have
an "untitled" fallback rather than handing writeIdea() a blank slug.
