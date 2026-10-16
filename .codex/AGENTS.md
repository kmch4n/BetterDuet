# BetterDuet Project Guidelines

## Project Scope

- BetterDuet is an unofficial Manifest V3 Chrome extension for Doshisha University's DUET (`duet.doshisha.ac.jp`), the student tutorial system.
- Treat `extension/` as the distributable source. There is no build step or package manifest. Automated tests live under `tests/` and run with the Node.js built-in test runner.
- Use `extension/manifest.json` as the source of truth for permissions, URL matches, script order, frame scope, and runtime timing.
- Keep user-facing documentation and specs in Japanese. Keep implementation identifiers and code comments in English.

## Spec-Driven Development

- `docs/spec/` is the single source of truth for behavior. Read `docs/spec/README.md` before any task that touches behavior.
- Implement only requirements whose spec status is `Accepted`. Do not implement `Draft` requirements, even when the intent seems obvious.
- When a task needs behavior the spec does not define, stop and propose a spec change (or add an open question to the spec) instead of deciding it in code.
- When code and spec disagree, the spec wins. Either fix the code, or propose a spec change first and wait for approval.
- Reference requirement IDs (for example `TAB-001`) in tests and in pull request descriptions. Every `Accepted` requirement needs at least one test or a documented manual check.
- After implementing, update the requirement's status to `Implemented` and record how it was verified, in the same change.
- `docs/spec/duet-platform.md` is the living spec of DUET's own behavior. Whenever you observe DUET behavior (intended or not), add an entry to its observation log (`E-NNN`, date, steps, result) and update the body. Mark anything unverified as such.

## Architecture

- Content scripts are plain browser JavaScript and should remain isolated with IIFEs.
- Shared browser utilities live under `extension/utils/` and are exposed through `window.BetterDuetUtils`.
- DUET keeps one server-side "current view" per session. Any request that does not match it invalidates the whole session (see `docs/spec/duet-platform.md`). All requests to DUET must go through the single serialized path defined in the spec; never send ad-hoc requests from feature code.

## Change Safety

- Never send a GET request to a DUET page URL or a POST from a stale view. Either one logs the user out of every tab.
- Prefer narrow DOM selectors with graceful fallbacks because DUET markup is external and can change without notice.
- Make injected UI idempotent so repeated initialization or DOM mutations do not create duplicates.
- Do not add external data transmission, broader host permissions, or new Chrome permissions without explicit approval.
- Do not add background crawling or bulk fetching of DUET pages. Requests must stay tied to an action the user took.
- Never trigger state-changing DUET operations (course registration, withdrawal, survey submission, contact changes, message replies) during verification without the user's explicit approval for that specific action.
- DUET pages contain names, student IDs, grades, and course lists. Do not paste real page content into issues, commits, fixtures, or logs; anonymize fixtures.
- Do not edit generated `_metadata` or archived `release/` packages unless the task explicitly requires it.
- Update `extension/manifest.json` when adding, removing, or reordering injected scripts.
- Before cutting a release or writing release notes, read `docs/RELEASING.md` and follow its steps and note format.

## Verification

- Run `node --test tests/*.test.js` when tests exist.
- Run `node --check` on every changed JavaScript file.
- Parse changed JSON files to confirm valid syntax.
- Run Prettier as a check when available; do not introduce a package manager solely for formatting.
- For behavior changes, manually load `extension/` from `chrome://extensions/` and test the affected real DUET page, including multi-tab states when relevant.
- If real DUET access is unavailable, clearly report which behavior remains manually unverified.
