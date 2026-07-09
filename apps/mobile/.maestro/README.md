# Maestro E2E flows

Device-level flows for the three core journeys the vitest screen smoke tests
can't cover (real keyboard, real navigation transitions, real persistence
across process death). These codify what `docs/smoke-test.md` previously
asked a human to do by hand.

## Prerequisites
- [Maestro CLI](https://maestro.mobile.dev): `curl -Ls "https://get.maestro.mobile.dev" | bash`
- An Android device/emulator connected via adb with Carnet installed
  (`npm run android:release` builds + installs the self-contained APK; a dev
  client works too if Metro is running and `adb reverse tcp:8081 tcp:8081`
  is set).

## Running
```bash
cd apps/mobile
maestro test .maestro/            # all flows, alphabetical order
maestro test .maestro/01-capture-idea.yaml   # one flow
```

Order matters: `03-search-filter` searches for the note that `01-capture-idea`
creates. Flow 01 leaves "Maestro smoke idea" in the vault — archive it from
the app (or remove `Ideas/maestro-smoke-idea.md`) to clean up.

## Conventions
- Selectors are user-visible text or accessibility labels — the same strings
  the vitest screen tests assert on, so a copy change breaks both loudly.
- Flows must not depend on personal vault content (03 uses the always-present
  "Idea" mode pill, not a tag).
- Flows restore global state they change (02 returns Appearance to "System").
