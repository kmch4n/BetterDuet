# Implementation Plan v1

Internal engineering plan for implementing every `Accepted` requirement in `docs/spec/`. This file is not a spec: when it disagrees with `docs/spec/`, the spec wins. Requirement IDs (`CORE-001`, `TAB-002`, ...) refer to the spec. Experiment IDs (`E-0NN`) refer to `docs/spec/duet-platform.md`.

## 0. Ground rules for implementers

- Read `.codex/AGENTS.md`, `docs/spec/README.md`, `docs/spec/architecture.md`, and the feature specs your task touches before writing code.
- Plain browser JavaScript, no build step, no npm dependencies. 4-space indentation, double quotes, semicolons.
- Content scripts and the service worker must not use `eval`, remote code, or `innerHTML` with untrusted strings.
- Never log form values, tokens, cookies, or page text. Log screen IDs and action names only, and only when `DEBUG` is true.
- Every file you create must pass `node --check`. Pure logic must have `node:test` tests under `tests/`.

## 1. File layout

```
extension/
  manifest.json
  rules.json                 # static declarativeNetRequest rules (GUARD-001)
  background.js              # service worker: state, queue, decisions (CORE-001..008)
  core.js                    # pure logic shared by SW, content scripts, and tests
  content/early-hook.js      # MAIN world, document_start: submit/popstate/xhr/keydown hooks
  content/page.js            # ISOLATED world on /gakusei/html/*: watcher, bridge, executor, notices, tab record
  content/landing.js         # ISOLATED world on /betterduet-landing*: landing UI and reopen (GUARD-002)
  content/notice.js          # ISOLATED world helper: notice bar renderer (NOTICE-001), shared by page.js and landing.js
  content/notice.css
tests/
  core.test.js
  rules.test.js
  manifest.test.js
```

`core.js` is a classic script that assigns `globalThis.BetterDuetCore = {...}` and also does `if (typeof module !== "undefined") module.exports = BetterDuetCore;` so Node tests can `require` it. The service worker loads it with `importScripts("core.js")`. Content scripts get it by listing it first in the `js` array.

## 2. manifest.json

```json
{
    "manifest_version": 3,
    "name": "BetterDuet",
    "version": "0.1.0",
    "description": "同志社大学の DUET を、複数のタブや再読み込みでも壊れずに使えるようにする非公式の拡張機能",
    "permissions": ["storage", "declarativeNetRequest"],
    "host_permissions": ["*://duet.doshisha.ac.jp/*"],
    "background": { "service_worker": "background.js" },
    "declarative_net_request": {
        "rule_resources": [{ "id": "guard", "enabled": true, "path": "rules.json" }]
    },
    "content_scripts": [
        { "matches": ["https://duet.doshisha.ac.jp/gakusei/html/*"], "js": ["content/early-hook.js"], "run_at": "document_start", "world": "MAIN" },
        { "matches": ["https://duet.doshisha.ac.jp/gakusei/html/*"], "js": ["core.js", "content/notice.js", "content/page.js"], "css": ["content/notice.css"], "run_at": "document_start" },
        { "matches": ["https://duet.doshisha.ac.jp/betterduet-landing*"], "js": ["core.js", "content/notice.js", "content/landing.js"], "css": ["content/notice.css"], "run_at": "document_start" }
    ]
}
```

Open risk (verify in E2E, see §9): the SSO entry GET is initiated from `doshisha.ex-tic.com`. If the redirect rule does not fire for that initiator without host permission for `doshisha.ex-tic.com`, stop and report; do not add the permission silently (CORE-008).

## 3. rules.json (GUARD-001)

One rule:

```json
[
    {
        "id": 1,
        "priority": 1,
        "action": {
            "type": "redirect",
            "redirect": { "regexSubstitution": "https://duet.doshisha.ac.jp/betterduet-landing?from=\\1" }
        },
        "condition": {
            "regexFilter": "^https://duet\\.doshisha\\.ac\\.jp/gakusei/html/([A-Za-z0-9/._-]*)",
            "resourceTypes": ["main_frame"],
            "requestMethods": ["get"]
        }
    }
]
```

## 4. core.js — pure logic (no chrome.*, no DOM globals except where a `Document` is passed in)

Constants:

- `MENU_SCREENS`: array of `{ screenId, label, formId, action }` from the table in `duet-platform.md` → "画面 ID とメニュー". Home is `{ screenId: "FB02001G", label: "ホーム", formId: "unloadform", action: "goHome" }`; every other entry is `{ formId: "menuform", action: "goFb" + digits + "g" }` (e.g. `FB17001G` → `goFb17001g`).
- `COMMON_FORM_IDS = ["unloadform", "member", "menuform"]`.
- `ENTRY_PATH = "/gakusei/html/fb/fb010/FB01090G.html"`, `ENTRY_FROM = "fb/fb010/FB01090G.html"`.
- `LANDING_PATH = "/betterduet-landing"`, `SSO_PORTAL_URL = "https://doshisha.ex-tic.com/idm/user/portal/"`.
- `NOTICES`: map from notice ID (`TAB-1`, `TAB-2`, `GUARD-1`..`GUARD-4`, `BACK-1`) to `{ kind: "info" | "warning", text, button?: { label, action } }`, texts copied verbatim from the specs. `button.action` is one of `"reopen"` or `"openPortal"`.
- `NAV_TIMEOUT_MS = 30000`, `DOWNLOAD_SETTLE_MS = 3000`.

Functions (all pure, all unit-tested):

| Function | Behavior |
|---|---|
| `screenIdFromAction(action)` | Basename without `.html` of a form action URL or path (`"/gakusei/html/fb/fb170/FB17001G.html"` → `"FB17001G"`); strips `?`, `;`, `#` suffixes. Returns `null` when no `FBxxxxxG` match. |
| `isMenuScreen(screenId)` | True for screen IDs in `MENU_SCREENS`. |
| `menuEntry(screenId)` | The `MENU_SCREENS` entry or `null`. |
| `classifyErrorText(text)` | `"transition"` if text contains `ページ間の移動でエラーが発生しました`, `"auth"` if it contains `認証エラー`, else `null`. |
| `extractFormTemplate(form)` | Given an `HTMLFormElement`-like object (`id`, `getAttribute("action")`, `querySelectorAll("input[type=hidden]")`), returns `{ formId, action, hidden: [[name, value], ...] }`. `__link_clicked__` is included with value `""`. |
| `isCommonForm(formId)` | `COMMON_FORM_IDS.includes(formId)`. |
| `isDownloadAction(actionName)` | `/download/i.test(actionName)`. |
| `viewKeyedName(name, formId)` | True when `name` starts with `formId + "/"` (the hidden field that encodes the view, e.g. `menuform/html/fb/fb020/FB02001G.html`). |
| `rewriteForLatest(snapshot, latestTemplate)` | `snapshot = { formId, action, fields: [[name, value], ...] }`. Returns a new snapshot whose `action` is `latestTemplate.action` and whose view-keyed field name is replaced by the latest template's view-keyed name. All other fields (including `__link_clicked__`) unchanged. Throws if the form IDs differ or the template lacks a view-keyed field. |
| `buildOpenPlan(screenId, latest)` | `latest = { forms: { [formId]: template } }`. Uses `menuEntry(screenId)` (falls back to home when not a menu screen). Returns `{ action, fields }` where fields = template hidden fields with `<formId>:__link_clicked__` set to `<formId>:<action>`. Returns `null` when the needed template is missing. |
| `decideSubmit({ pageGen, latestGen, loggedOut, formId })` | Returns `"loggedOut"` if `loggedOut`; `"send"` if `pageGen === latestGen`; `"rewrite"` if `isCommonForm(formId)`; otherwise `"block"`. (CORE-004, TAB-001, TAB-002, TAB-005) |
| `menuAncestorOf(record)` | For a tab record (below), the `menuScreenId`. |
| `applyLoad(record, { tabId, screenId, viaBack })` | Returns the next tab record. Record shape: `{ tabId, screenId, menuScreenId, history: [{ s, m }...], index }` where each history entry stores the screen ID `s` and its menu screen `m`. If `screenId` is a menu screen, `menuScreenId = screenId`; otherwise keep the previous `menuScreenId` (or `"FB02001G"` if none). If `viaBack`, keep `history` and `index` unchanged (the caller already moved `index` with `planBack`) but replace the entry at `index` with the loaded screen. Otherwise truncate `history` after `index`, push `{ s: screenId, m: menuScreenId }` unless `s` equals the current entry's `s`, and set `index` to the last position. Always set `tabId`. Cap history at 50 entries (drop oldest, adjust index). `record` may be `null` (first load). |
| `planBack(record)` | Returns `{ targetScreenId, nextIndex }` or `null`. Walks back from `index - 1` and returns the first entry whose `m` differs from the current entry's `m`; the target is that entry's `m` (detail screens are reopened as their menu screen). Returns `null` when no such entry exists. (BACK-002, BACK-003) |
| `landingTarget({ from, record, ownTabId, loggedOut })` | Implements GUARD-002 ordering. Returns `{ kind: "entry" }` when `from === ENTRY_FROM`; `{ kind: "loggedOut" }` when `loggedOut`; `{ kind: "screen", screenId: record.menuScreenId, duplicated: record.tabId !== ownTabId, hadDetail: !isMenuScreen(record.screenId) }` when a record exists; else `{ kind: "screen", screenId: "FB02001G", duplicated: false, hadDetail: false }`. |
| `isLogoutBody(body)` | True when a string body contains `unloadform:__link_clicked__=unloadform:closeWindow` in raw or URL-encoded (`%3A`) form. (CORE-006) |
| `classifyEntryResponse({ finalUrl, html })` | Used by revival. `"entry"` if `finalUrl` host is `duet.doshisha.ac.jp` and the HTML contains a `form1` with an element whose id is `goHome`; `"duetError"` if `classifyErrorText(html)` is non-null; else `"ssoExpired"`. Takes the HTML string so it is testable without DOM. |

## 5. Tab record in sessionStorage (CORE-002)

Key `betterduet:tab`, JSON of the record above. Written by `page.js` on every successful DUET screen load, and by `landing.js` after a duplicated tab reopens (rewrite `tabId`). Only screen IDs and the tab ID — no form data.

Key `betterduet:pendingBack` (string `"1"`): set by `page.js` right before submitting a back navigation; consumed on the next load to call `applyLoad(..., { viaBack: true })`.

## 6. Service worker (background.js)

### State (`chrome.storage.session`, key `betterduet:state`)

```js
{
    gen: 0,                 // increments on every recorded screen load
    latest: null,           // { gen, tabId, screenId, forms: { formId: template } }
    loggedOut: false
}
```

Load it at the start of every message handler (the SW may restart). Write it back after mutation.

### Queue (CORE-003)

In-memory FIFO with a single active job. A job is `{ kind, tabId, resolve, ... }`. The active job holds the lock until one of:

- `page:loaded` from the job's tab (navigation jobs),
- `DOWNLOAD_SETTLE_MS` elapsed (download jobs),
- `NAV_TIMEOUT_MS` elapsed (any navigation job; do not change `latest`),
- the executor reports completion (fetch-only jobs like revival).

Keep the SW alive while the queue is non-empty by having content scripts hold an open `chrome.runtime.connect` port for the duration of a pending request (a pending port keeps the SW alive).

### Messages (content → SW), all via `chrome.runtime.sendMessage` unless noted; SW replies with `sendResponse`.

| Message | Payload | SW behavior |
|---|---|---|
| `page:loaded` | `{ screenId, forms, isError: null }` | `gen++`, `latest = { gen, tabId, screenId, forms }`, store. Resolve the active navigation job if it belongs to this tab. Reply `{ gen, tabId }`. (CORE-001) |
| `page:error` | `{ errorKind, record }` | Resolve active job for this tab. If `loggedOut` → reply `{ notice: "TAB-2" }`. Else enqueue a `revive-and-open` job for this tab targeting `pendingTargetFor(tabId) ?? record.menuScreenId ?? "FB02001G"` with `attempt` guard (one revival per user action, GUARD-003). Reply `{ action: "revive", ... }` via the job flow below. |
| `submit:request` | `{ pageGen, formId, actionName, snapshot }` | Enqueue. When it runs: `decideSubmit`. `send` → reply `{ decision: "send" }` and keep lock until load (or download settle). `rewrite` → reply `{ decision: "rewrite", snapshot: rewriteForLatest(snapshot, latest.forms[formId]) }` and keep lock. `block` → reply `{ decision: "block", notice: "TAB-1" }`, release lock. `loggedOut` → reply `{ decision: "block", notice: "TAB-2" }`, release. Remember `pendingTarget` = menu screen opened by the action when the action is a menu action (for GUARD-003 targeting). |
| `open:request` | `{ screenId, reason: "landing" \| "back" \| "reopen" \| "entry" }` | Enqueue. When it runs: if `loggedOut && reason !== "entry"` → reply `{ notice: "TAB-2" }`. If `reason === "entry"` → clear `loggedOut`. If `latest` exists and `reason !== "entry"` → reply `{ plan: buildOpenPlan(screenId, latest) }`, hold lock until load. Otherwise (no `latest`, or entry with unknown liveness) → reply `{ revive: true, screenId }`; the tab runs the revival executor (§7.4) and then sends `revive:done`. Entry with a live `latest`: reply with a plan for home (TAB-004). |
| `revive:done` | `{ result: "ok" \| "ssoExpired" \| "failed", forms?, screenId? }` | On `ok`: record the fetched home as `latest` (gen++, `tabId` = null because no tab shows it), then reply `{ plan: buildOpenPlan(target, latest) }` where target is the job's target screen (for `entry` with a dead session the target is `FB01701G`, GUARD-002 step 1). On `ssoExpired` → reply `{ notice: "GUARD-4" }`. On `failed` → `{ notice: "GUARD-3" }`. Release lock only after the follow-up navigation loads. |
| `xhr:logout` | `{}` | `loggedOut = true`. (CORE-006) |
| `state:get` | `{}` | Reply `{ gen: latest?.gen, loggedOut, tabId }` (no forms). |

Never send form templates to a tab except inside a `rewrite`/`plan` reply addressed to that tab.

## 7. Content scripts

### 7.1 early-hook.js (MAIN world, document_start)

Communicates with `page.js` through `window.postMessage` messages tagged `{ __betterduet: "<channel>", nonce }`. `page.js` generates a random nonce at document_start and sends it once via a `CustomEvent("betterduet:init", { detail: nonce })` on `document`; early-hook ignores messages without that nonce afterwards.

1. **Submit interception (CORE-004).** Save `const nativeSubmit = HTMLFormElement.prototype.submit`. Replace it with a function that, for forms whose `id` is one of `unloadform`, `member`, `form1`, `menuform`:
   - snapshots `{ formId, action: form.getAttribute("action"), fields: [[name, value] for every named control except type=file], hasFile }` synchronously (DUET clears `__link_clicked__` right after calling submit),
   - posts `submit:intercepted` to `page.js`, and returns without submitting.
   - Forms with other IDs, or when the hook is disabled (no init within 2 s), call `nativeSubmit` directly (P-5).
   Also add a capture-phase `submit` event listener on `document` that does the same for real submit events (`preventDefault()` first).
   Before DUET scripts run, also snapshot every `a[onclick]` attribute lazily at `DOMContentLoaded` into a `WeakMap`, so a blocked submit can restore links that DUET replaced with `return false`.
2. **Executing a decision.** On `submit:execute` from `page.js` with `{ snapshot }`: find the form by ID; set its `action` attribute to `snapshot.action`; for each field, find the control by **original** name (for the view-keyed hidden field, find the control whose name starts with `formId + "/"`) and set its `name`/`value` from the snapshot; then `nativeSubmit.call(form)`.
   On `submit:restore` (blocked): `window.mMOnceTimeFlg = true`; restore saved `onclick` attributes; `document.querySelectorAll("*")` cursor reset via `document.body.style.cursor = ""` and DUET's `changeCursor("auto")` if defined.
3. **Popstate (BACK-001).** Wrap `window.addEventListener` so `type === "popstate"` registrations from page scripts are dropped. Register our own listener with the saved original `addEventListener`: on `popstate`, immediately `history.pushState("push", null, null)` and post `back:requested` to `page.js`.
4. **Alt+← (BACK-004).** Add a capture-phase `keydown` listener on `window`: when `altKey && key === "ArrowLeft"` and no other modifier, call `event.stopPropagation()` (not `preventDefault`) so DUET's document handler never sees it and the browser performs Back.
5. **Logout (CORE-006).** Wrap `XMLHttpRequest.prototype.send`: if `typeof body === "string" && isLogoutBody(body)` (inline a copy of the check; MAIN world cannot load `core.js` — keep the two in sync and test the regex in core), post `xhr:logout`. Always call the original.

### 7.2 page.js (ISOLATED world, /gakusei/html/*)

On `DOMContentLoaded`:

1. Determine page kind: error page if `classifyErrorText(document.body.innerText)` is non-null; screen page if a `menuform` or `form1` exists and `screenIdFromAction(menuform?.action ?? form1.action)` is non-null. The entry page `FB01090G` itself is never shown (GET is gated), so treat any page without `menuform` as non-screen and do nothing (P-5).
2. Screen page: send `page:loaded` with templates for all four forms (missing forms omitted). Store the returned `gen` as `pageGen`. Update the tab record with `applyLoad` (consume `betterduet:pendingBack`). If a notice was queued for this tab by the previous step (stored in `sessionStorage` key `betterduet:notice`), render and clear it.
3. Error page: send `page:error` with the tab record; follow the reply (notice or revival executor §7.4, then navigate with the returned plan via §7.3).

Handlers:

- `submit:intercepted` → send `submit:request` with `pageGen`. On `send`/`rewrite` → post `submit:execute` with the (possibly rewritten) snapshot. On `block` → post `submit:restore` and render the notice (`TAB-1` with a "reopen" button, or `TAB-2` with "openPortal").
- `back:requested` → `planBack(record)`. `null` → render `BACK-1`. Otherwise set `betterduet:pendingBack`, write `index = nextIndex` into the record, and send `open:request` with `reason: "back"`; navigate with the plan.
- Notice button "reopen" → `open:request` with `screenId = record.menuScreenId`, `reason: "reopen"`.
- Notice button "openPortal" → `window.open(SSO_PORTAL_URL, "_blank", "noopener")`.

### 7.3 Navigating with a plan

Create a detached `<form method="post">` in the current document with `action = plan.action` and hidden inputs from `plan.fields`, append to `document.documentElement`, and call `HTMLFormElement.prototype.submit.call(form)` **from the isolated world** (the isolated world's prototype is not hooked). Used by `page.js` and `landing.js`.

### 7.4 Revival executor (GUARD-003, GUARD-004)

Runs in the tab's isolated world (same-origin fetch with cookies):

1. `fetch(ENTRY_PATH, { credentials: "include" })` → `classifyEntryResponse({ finalUrl: res.url, html })`. `duetError` → fetch once more and classify again. `ssoExpired` after that → `revive:done { result: "ssoExpired" }`.
2. Parse with `DOMParser`; take `form1`; POST its hidden fields with `form1:__link_clicked__ = form1:goHome` to its action via `fetch`.
3. Parse the home response; if `classifyErrorText` is non-null → `revive:done { result: "failed" }`. Else extract templates for the four forms and send `revive:done { result: "ok", forms, screenId: "FB02001G" }`.

### 7.5 landing.js (GUARD-002)

At `document_start`: stop the 404 body from flashing (`document.documentElement.style.visibility = "hidden"` until our UI is in place). On `DOMContentLoaded`: replace the body with a centered panel saying `DUET を開いています…`.

Read `from` from the query and the record from `sessionStorage`. Ask the SW for `{ tabId, loggedOut }` via `state:get`, then `landingTarget(...)`:

- `entry` → `open:request { screenId: "FB02001G", reason: "entry" }`.
- `loggedOut` → render `TAB-2` in the panel; stop.
- `screen` → `open:request { screenId, reason: "landing" }`. If `duplicated`, write the record back with the own `tabId`. If `hadDetail`, store `GUARD-1` in `betterduet:notice` so `page.js` shows it after the load.

Handle replies: `plan` → §7.3; `revive` → §7.4 then `revive:done` reply → plan or notice; `notice` → render in panel. A successful revival stores `GUARD-2` in `betterduet:notice` except when `reason === "entry"`.

### 7.6 notice.js / notice.css (NOTICE-001)

`BetterDuetNotice.show(id, { onReopen, onOpenPortal })`: renders `NOTICES[id]` into a single container `#betterduet-notice` inserted at the top of `#contents` (or `document.body` on the landing page). Re-showing replaces the existing bar (no stacking). Close button `×` with `aria-label="閉じる"`. `role="alert"` for warning, `role="status"` for info. Buttons are real `<button>` elements. Build DOM with `createElement`/`textContent` only. CSS uses DUET's blue (`#336699`-ish) for info and amber for warning, readable contrast, does not overlap page controls (it is in normal flow).

## 8. Tests (node:test)

- `tests/core.test.js`: every function in §4 with normal, edge, and error cases. Use tiny fake form objects for `extractFormTemplate`. Name tests with requirement IDs, e.g. `test("TAB-001 rewriteForLatest swaps action and view-keyed name", ...)`.
- `tests/rules.test.js`: parse `extension/rules.json`; assert the regex matches `https://duet.doshisha.ac.jp/gakusei/html/fb/fb010/FB01002G.html` and the entry page, does not match `/kokai/html/...`, `/front/js/...`, `/betterduet-landing`; compute the substitution and assert `from=fb/fb010/FB01002G.html`; assert `requestMethods` is `["get"]` and `resourceTypes` is `["main_frame"]` (GUARD-001).
- `tests/manifest.test.js`: permissions exactly `["storage", "declarativeNetRequest"]`, host permissions exactly `["*://duet.doshisha.ac.jp/*"]`, every referenced file exists (CORE-008).

Run: `node --test tests/*.test.js`.

## 9. Manual E2E (performed by the lead, not by implementers)

Load `extension/` unpacked (disable `BetterDuet Probe` first; both hook `addEventListener`). Then walk every acceptance criterion in the specs on the real DUET, in this order: GUARD-001, CORE-001/003, TAB-001, TAB-002, TAB-003, TAB-004 (alive and dead), BACK-001..004, GUARD-002, GUARD-003, CORE-005 (download via fetch inspection only, no file saved), CORE-006/TAB-005 (logout — this ends the user's DUET session; do it last), NOTICE-001 keyboard check. Record new facts as `E-0NN` in `duet-platform.md`, mark requirements `Implemented` with the verification method.

## 10. Task split for implementer subagents

| Task | Files owned | Depends on |
|---|---|---|
| A. Core logic + tests | `extension/core.js`, `tests/core.test.js` | — |
| B. Manifest, rules, tests | `extension/manifest.json`, `extension/rules.json`, `tests/rules.test.js`, `tests/manifest.test.js` | — |
| C. Service worker | `extension/background.js` | A |
| D. Content scripts + notices | `extension/content/*` | A |

A and B run first (in parallel). C and D run in parallel after A, against the message table in §6 exactly. The lead audits each task's diff against this plan and the spec before merging the next step.
