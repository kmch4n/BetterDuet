# Implementation Plan v2

Internal engineering plan for implementing every `Accepted` requirement in `docs/spec/`. This file is not a spec: when it disagrees with `docs/spec/`, the spec wins. Requirement IDs (`CORE-001`, `TAB-002`, ...) refer to the spec. Experiment IDs (`E-0NN`) refer to `docs/spec/duet-platform.md`.

v2 incorporates the review of v1 and two extra experiments: E-025 (the DNR redirect fires for the SSO-initiated GET with only the DUET host permission) and E-026 (toolbar Back produces an in-document `popstate` once the page has user activation).

## 0. Ground rules for implementers

- Read `.codex/AGENTS.md`, `docs/spec/README.md`, `docs/spec/architecture.md`, and the feature specs your task touches before writing code.
- Plain browser JavaScript, no build step, no npm dependencies. 4-space indentation, double quotes, semicolons. Wrap content scripts in IIFEs.
- No `eval`, no remote code, no `innerHTML` with dynamic strings (use `createElement` / `textContent`).
- Never log or send form values, tokens, cookies, or page text. Debug logs (behind `const DEBUG = false`) may include screen IDs, action names, message types, and job IDs only.
- Every JS file must pass `node --check`. Pure logic must have `node:test` tests under `tests/`. Run `node --test tests/*.test.js`.
- Do not touch files owned by another task (§11).

## 1. File layout

```
extension/
  manifest.json
  rules.json                 # static DNR rule (GUARD-001)
  core.js                    # pure logic + constants + JSDoc typedefs, shared everywhere
  background.js              # service worker: state, job queue, decisions
  content/early-hook.js      # MAIN world, document_start: submit / popstate / keydown / XHR hooks
  content/notice.js          # ISOLATED: notice bar renderer (NOTICE-001)
  content/notice.css
  content/nav.js             # ISOLATED: shared helpers for page.js and landing.js (plan submit, revival executor, SW messaging with keepalive)
  content/page.js            # ISOLATED on /gakusei/html/*
  content/landing.js         # ISOLATED on /betterduet-landing*
tests/
  core.test.js
  early-hook.test.js         # loads early-hook.js in node:vm with fakes to test isLogoutBody parity and the submit snapshot
  rules.test.js
  manifest.test.js
```

`core.js` is a classic script: `const BetterDuetCore = (() => { ...; return {...}; })(); globalThis.BetterDuetCore = BetterDuetCore; if (typeof module !== "undefined") module.exports = BetterDuetCore;`. The SW loads it with `importScripts("core.js")`. Content scripts list it first.

## 2. manifest.json (CORE-008)

```json
{
    "manifest_version": 3,
    "name": "BetterDuet",
    "version": "0.1.0",
    "description": "同志社大学の DUET を、複数のタブや再読み込みでも壊れずに使えるようにする非公式の拡張機能",
    "permissions": ["storage", "declarativeNetRequest"],
    "host_permissions": ["*://duet.doshisha.ac.jp/*"],
    "background": { "service_worker": "background.js" },
    "declarative_net_request": { "rule_resources": [{ "id": "guard", "enabled": true, "path": "rules.json" }] },
    "content_scripts": [
        { "matches": ["https://duet.doshisha.ac.jp/gakusei/html/*"], "js": ["content/early-hook.js"], "run_at": "document_start", "world": "MAIN" },
        { "matches": ["https://duet.doshisha.ac.jp/gakusei/html/*"], "js": ["core.js", "content/notice.js", "content/nav.js", "content/page.js"], "css": ["content/notice.css"], "run_at": "document_start" },
        { "matches": ["https://duet.doshisha.ac.jp/betterduet-landing*"], "js": ["core.js", "content/notice.js", "content/nav.js", "content/landing.js"], "css": ["content/notice.css"], "run_at": "document_start" }
    ]
}
```

`chrome.tabs.onRemoved` needs no permission. `chrome.storage.session` is used only by the SW (default access level `TRUSTED_CONTEXTS`; content scripts never touch it).

## 3. rules.json (GUARD-001)

Verified in E-025. Exactly:

```json
[
    {
        "id": 1,
        "priority": 1,
        "action": { "type": "redirect", "redirect": { "regexSubstitution": "https://duet.doshisha.ac.jp/betterduet-landing?from=\\1" } },
        "condition": { "regexFilter": "^https://duet\\.doshisha\\.ac\\.jp/gakusei/html/([A-Za-z0-9/._-]*)", "resourceTypes": ["main_frame"], "requestMethods": ["get"] }
    }
]
```

## 4. core.js

### 4.1 Constants

- `MENU_SCREENS`: array of `{ screenId, label, formId, action }`, from `duet-platform.md` "画面 ID とメニュー". Home: `{ screenId: "FB02001G", label: "ホーム", formId: "unloadform", action: "goHome" }`. Others: `formId: "menuform"`, `action: "goFb" + digits + "g"` (e.g. `FB17001G` → `goFb17001g`).
- `HOME = "FB02001G"`, `NOTICES_SCREEN = "FB01701G"` (お知らせ, used for entry with a new session).
- `DUET_FORM_IDS = ["unloadform", "member", "form1", "menuform"]`, `COMMON_FORM_IDS = ["unloadform", "member", "menuform"]`.
- `ENTRY_PATH = "/gakusei/html/fb/fb010/FB01090G.html"`, `ENTRY_FROM = "fb/fb010/FB01090G.html"`, `ENTRY_SCREEN = "FB01090G"`.
- `LANDING_PATH = "/betterduet-landing"`, `SSO_PORTAL_URL = "https://doshisha.ex-tic.com/idm/user/portal/"`.
- `LOGOUT_PATTERN = /unloadform(?::|%3A)__link_clicked__=unloadform(?::|%3A)closeWindow/i` (jQuery `$.param` encodes `:` as `%3A` in both key and value).
- `NOTICES`: `{ [id]: { kind: "info" | "warning", text, button: null | { label, action: "reopen" | "openPortal" } } }` for `TAB-1`, `TAB-2`, `GUARD-1`, `GUARD-2`, `GUARD-3`, `GUARD-4`, `BACK-1`, with texts copied verbatim from the specs.
- Timeouts: `NAV_TIMEOUT_MS = 30000`, `DOWNLOAD_SETTLE_MS = 3000`, `REVIVE_TIMEOUT_MS = 20000`, `ACK_TIMEOUT_MS = 1500`, `GEN_WAIT_MS = 5000`, `KEEPALIVE_MS = 10000`.

### 4.2 Typedefs (JSDoc in core.js; the shapes below are normative)

```js
/** @typedef {{ formId: string, action: string, fields: Array<[string, string]> }} FormTemplate */
//   action = the form's action attribute as written in the page; fields = every hidden input [name, value],
//   with `${formId}:__link_clicked__` forced to "".
/** @typedef {{ [formId: string]: FormTemplate }} FormMap */
/** @typedef {{ action: string, fields: Array<[string, string]> }} Plan */
//   A ready-to-submit POST: fields already include `${formId}:__link_clicked__` = `${formId}:${action}`.
/** @typedef {{ s: string, m: string }} HistoryEntry */   // screen ID and its menu screen
/** @typedef {{ tabId: number, screenId: string, menuScreenId: string, history: HistoryEntry[], index: number }} TabRecord */
```

### 4.3 Functions (pure, unit-tested)

| Function | Behavior |
|---|---|
| `screenIdFromAction(action)` | Basename without `.html` of a URL or path; strips `?…`, `;…`, `#…`. `/FB\d{5}G/` must match; else `null`. |
| `isMenuScreen(id)`, `menuEntry(id)` | Lookup in `MENU_SCREENS`. |
| `screenIdFromActionName(actionName)` | `"goFb17001g"` → `"FB17001G"`, `"goHome"` → `HOME`; else `null`. Used to learn which menu screen a common action opens. |
| `classifyErrorText(text)` | `"transition"` / `"auth"` / `null` (by the two Japanese error phrases in `duet-platform.md`). |
| `templateFromForm(form)` | From an `HTMLFormElement`-like object → `FormTemplate`. |
| `isViewKeyedName(name, formId)` | `name.startsWith(formId + "/")`. |
| `isCommonForm(id)`, `isDuetForm(id)`, `isDownloadAction(name)` | As named; download = `/download/i`. |
| `buildOpenPlan(screenId, forms)` | Menu entry for `screenId` (fall back to `HOME` when not a menu screen); returns a `Plan` from `forms[entry.formId]`, or `null` if that template is missing. |
| `rewriteTemplateFor(liveFormId, latestTemplate)` | Returns `{ action, viewKeyedName }` from the latest template of the same form; throws if IDs differ or no view-keyed field exists. |
| `decideSubmit({ pageGen, latestGen, loggedOut, formId })` | `"loggedOut"` if `loggedOut`; `"send"` if `pageGen === latestGen`; `"rewrite"` if `isCommonForm(formId)`; else `"block"`. |
| `applyLoad(record, { tabId, screenId, pendingBack })` | Next `TabRecord`. `menuScreenId` = `screenId` if menu screen, else previous `menuScreenId` or `HOME`. If `pendingBack` is set and `pendingBack.target === menuScreenId`: keep history, set `index = pendingBack.nextIndex`, and set `history[index] = { s: screenId, m: menuScreenId }`. Otherwise: truncate after `index`, push `{ s, m }` unless `s` equals the current entry's `s`, `index` = last. Cap 50 (drop oldest, shift index). `record` may be `null`. Always set `tabId`. |
| `planBack(record)` | Let `cur = record.history[record.index]`. Walk `i = index - 1 … 0`; return `{ targetScreenId: history[i].m, nextIndex: i }` for the first `i` where `history[i].m !== cur.s`. `null` if none. Test cases must include: home → 成績 → お知らせ, back twice; 登録科目一覧 → detail, back once (target `FB17001G`); single entry (null). |
| `landingTarget({ from, record, ownTabId, loggedOut })` | `from === ENTRY_FROM` → `{ kind: "entry" }`; else `loggedOut` → `{ kind: "loggedOut" }`; else record → `{ kind: "screen", screenId: record.menuScreenId, duplicated: record.tabId !== ownTabId, hadDetail: !isMenuScreen(record.screenId) }`; else `{ kind: "screen", screenId: HOME, duplicated: false, hadDetail: false }`. |
| `isLogoutBody(body)` | `typeof body === "string" && LOGOUT_PATTERN.test(body)`. |
| `classifyEntryHtml(html)` | `"entry"` if `html` contains a `form1` and `form1:goHome` (the onclick of `#goHome` on the entry page, E-020-style markup); `"duetError"` if `classifyErrorText(html)`; else `"unknown"`. |

## 5. Tab-local storage (sessionStorage on the DUET origin; screen IDs only)

| Key | Value | Written by | Read by |
|---|---|---|---|
| `betterduet:tab` | `TabRecord` JSON | page.js after every screen load | page.js, landing.js |
| `betterduet:pendingBack` | `{ nextIndex, target }` | page.js before a back navigation | page.js `applyLoad` on next load (then removed) |
| `betterduet:notice` | notice ID | landing.js / page.js before a navigation | page.js after the next screen load (then removed) |
| `betterduet:revived` | job ID | nav.js right before navigating after a revival | page.js: if set when an error page loads → `GUARD-3`, no new revival; removed on any successful screen load (GUARD-003 one-revival rule) |

## 6. Service worker (background.js)

### 6.1 State

In-memory cache mirrored to `chrome.storage.session` under `betterduet:state`. Load once per SW start (`await stateReady`). All mutations go through `updateState(fn)` which chains on a single promise so writes never interleave.

```js
{ gen: 0, latest: null /* { gen, tabId, screenId, forms } */, loggedOut: false, job: null /* { jobId, tabId, kind, deadline } */ }
```

On SW start, if `job` exists and `deadline < Date.now()`, drop it and set `latest = null` (server state unknown → next action goes through GUARD-003 recovery; the "entry fetch returns duetError → refetch" rule makes this safe).

### 6.2 Job queue (CORE-003)

One active job; others wait in an in-memory FIFO. A job record `{ jobId, tabId, kind: "nav" | "download" | "revive" | "decision", deadline }` is persisted in `state.job` while active.

- `nav`: ends on `page:loaded` / `page:error` / `page:other` from `tabId`, on `chrome.tabs.onRemoved(tabId)`, or at `deadline = now + NAV_TIMEOUT_MS`. On timeout or tab removal: set `latest = null`.
- `download`: ends after `DOWNLOAD_SETTLE_MS`; `latest` unchanged (E-022).
- `revive`: ends on `revive:done` or at `now + REVIVE_TIMEOUT_MS` (timeout → `latest = null`, reply `GUARD-3`).
- `decision` (block / loggedOut): ends immediately after replying.

Content scripts that are waiting on a request keep the SW alive by holding a `chrome.runtime.connect({ name: "keepalive" })` port and posting `{ ping: true }` every `KEEPALIVE_MS` until the reply arrives (nav.js `withKeepalive`).

### 6.3 Messages

All requests are `chrome.runtime.sendMessage({ type, ...payload })`; every reply has a `type` field. `tabId` always comes from `sender.tab.id`, never from the payload.

| Request `type` | Payload | Replies (`type` discriminated union) |
|---|---|---|
| `page:loaded` | `{ screenId, forms: FormMap }` | `{ type: "loaded", gen }`. Effect: `gen++`, `latest = { gen, tabId, screenId, forms }`, `loggedOut` unchanged; ends this tab's `nav` job. |
| `page:entry` | `{ forms: FormMap }` (entry page shown directly, i.e. the gate was bypassed) | `{ type: "loaded", gen }`. Effect: `loggedOut = false`, `gen++`, `latest = { gen, tabId, screenId: ENTRY_SCREEN, forms }`. |
| `page:other` | `{}` (a /gakusei/html page that is neither screen, entry, nor error) | `{ type: "ok" }`; ends this tab's `nav` job; `latest = null`. |
| `page:error` | `{ errorKind, targetScreenId }` | Ends this tab's `nav` job. `loggedOut` → `{ type: "notice", id: "TAB-2" }`. Else enqueue `revive` → when it runs `{ type: "revive", jobId, targetScreenId }`. |
| `submit:request` | `{ pageGen, formId, actionName }` | Enqueue; when it runs, `decideSubmit`: `send` → `{ type: "send", jobId }` (start `nav`, or `download` if `isDownloadAction`); `rewrite` → `{ type: "rewrite", jobId, action, viewKeyedName }` from `rewriteTemplateFor(formId, latest.forms[formId])` (if that throws or `latest` is null → treat as `block`), start `nav`; `block` → `{ type: "notice", id: "TAB-1" }`; `loggedOut` → `{ type: "notice", id: "TAB-2" }`. If the action is a menu action, remember `pendingTarget[tabId] = screenIdFromActionName(actionName)` until the job ends. |
| `open:request` | `{ screenId, reason: "landing" \| "back" \| "reopen" \| "entry" }` | Enqueue; when it runs: `reason === "entry"` → `loggedOut = false`. If `loggedOut` → `{ type: "notice", id: "TAB-2" }`. If `latest` → `{ type: "plan", jobId, plan: buildOpenPlan(reason === "entry" ? HOME : screenId, latest.forms) }` and start `nav` (a `null` plan → fall through to revive). Else → `{ type: "revive", jobId, targetScreenId: reason === "entry" ? NOTICES_SCREEN : screenId }` and start `revive`. |
| `revive:done` | `{ jobId, result: "ok" \| "ssoExpired" \| "failed", forms? }` | Must match the active job's `jobId` (else `{ type: "stale" }`). `ok` → `gen++`, `latest = { gen, tabId: null, screenId: HOME, forms }`, then `{ type: "plan", jobId, plan: buildOpenPlan(target, latest.forms) }` and switch the job to `nav`. `ssoExpired` → `{ type: "notice", id: "GUARD-4" }`. `failed` → `{ type: "notice", id: "GUARD-3" }`. |
| `xhr:logout` | `{}` | `{ type: "ok" }`. Effect: `loggedOut = true`, `latest = null`. |
| `state:get` | `{}` | `{ type: "state", tabId, loggedOut, hasLatest }` (never forms). |

Templates leave the SW only inside `plan` / `rewrite` replies to the requesting tab. The SW never receives `form1` field values.

## 7. Content scripts

### 7.1 early-hook.js (MAIN world, document_start)

Channel: `page.js` dispatches `document.dispatchEvent(new CustomEvent("betterduet:init", { detail: nonce }))` at document_start. The hook stores the nonce; afterwards both sides use `window.postMessage({ __betterduet: <type>, nonce, ...payload }, location.origin)` and ignore messages with a wrong nonce or `event.source !== window`.

MAIN → ISOLATED: `submit:intercepted { reqId, formId, actionName, isEvent }`, `back:requested {}`, `xhr:logout {}`.
ISOLATED → MAIN: `submit:execute { reqId, rewrite: null | { action, viewKeyedName } }`, `submit:restore { reqId }`, `hook:disable {}`.

1. **Submit hook (CORE-004).** Save `nativeSubmit = HTMLFormElement.prototype.submit` and `nativeRequestSubmit`. Replace `submit` with a function that, when the hook is enabled and `isDuetForm(this.id)`:
   - synchronously records `pending[reqId] = { form: this, linkValue: this.elements[this.id + ":__link_clicked__"]?.value, onclicks: snapshotOnclicks() }` (`snapshotOnclicks` saves every `a` element's current `onclick` attribute, or `null` when absent),
   - posts `submit:intercepted` with `actionName` = the part after `":"` in `linkValue`,
   - starts an `ACK_TIMEOUT_MS` timer: if no `submit:execute`/`submit:restore` arrives, disable the hook and run the native submit for this request (P-5: extension gone or broken).
   Otherwise call `nativeSubmit`.
   Add a capture-phase `submit` listener on `document`: for DUET forms, `preventDefault()`, record `pending` with `submitter = event.submitter`, post `submit:intercepted` with `isEvent: true`.
2. **Execute.** On `submit:execute`: restore `__link_clicked__` to `linkValue`; if `rewrite`, set `form.action = rewrite.action` and rename the hidden input whose name starts with `formId + "/"` to `rewrite.viewKeyedName`; then `nativeSubmit.call(form)`, or for `isEvent` set a re-entry flag and `nativeRequestSubmit.call(form, submitter)`.
3. **Restore (blocked).** On `submit:restore`: after a `setTimeout(0)` (DUET disables links synchronously after `submit()` returns), set `window.mMOnceTimeFlg = true`, restore each saved `onclick` (or `removeAttribute("onclick")` when it was `null`), and reset cursors with `window.jQuery ? jQuery("*").css("cursor", "") : null`.
4. **Disable.** On `hook:disable` (sent by page.js when `chrome.runtime?.id` is gone) or on ack timeout: all hooks pass through to native behavior from then on.
5. **Popstate (BACK-001/002).** Wrap `window.addEventListener` so page registrations of `popstate` are dropped while enabled. With the saved original, listen for `popstate`: `history.pushState("push", null, null)` then post `back:requested`.
6. **Alt+← (BACK-004).** Capture-phase `keydown` on `window`: `altKey && key === "ArrowLeft"` with no Ctrl/Shift/Meta → `event.stopPropagation()` only.
7. **Logout (CORE-006).** Wrap `XMLHttpRequest.prototype.send`: if `LOGOUT_PATTERN` (inlined copy) matches a string body, post `xhr:logout`. Always call the original. `tests/early-hook.test.js` asserts the inlined pattern equals `BetterDuetCore.LOGOUT_PATTERN.source`.

### 7.2 nav.js (ISOLATED helpers, exposed as `globalThis.BetterDuetNav`)

- `send(message)`: `chrome.runtime.sendMessage` wrapped with `withKeepalive`; rejects if `chrome.runtime?.id` is undefined.
- `submitPlan(plan)`: build a detached `<form method="post">` with `action = plan.action` and hidden inputs from `plan.fields`, append to `document.documentElement`, `HTMLFormElement.prototype.submit.call(form)` (isolated-world prototype, not hooked).
- `revive(jobId)`: GUARD-003 executor. `fetch(ENTRY_PATH, { credentials: "include", redirect: "manual" })`; `opaqueredirect`, network error, or non-2xx → `ssoExpired`. Classify the text with `classifyEntryHtml`; `duetError` → fetch once more; still not `entry` → `ssoExpired`. Parse with `DOMParser`, take `form1`, POST its hidden fields with `form1:__link_clicked__ = form1:goHome` (`fetch`, `credentials: "include"`, `redirect: "manual"`). If the home HTML is an error → `failed`. Else `templateFromForm` for the four forms → `send({ type: "revive:done", jobId, result: "ok", forms })` and return the reply.
- `handleReply(reply, { onNotice })`: `plan` → `submitPlan`; `revive` → `revive(reply.jobId)` then handle its reply recursively (set `betterduet:revived = jobId` before submitting the plan that follows a revival); `notice` → `onNotice(id)`.

### 7.3 page.js (ISOLATED, /gakusei/html/*)

At document_start: create the nonce and dispatch `betterduet:init`. If `chrome.runtime?.id` is missing at any point, post `hook:disable`.

On `DOMContentLoaded`:

1. Error page (`classifyErrorText(document.body.innerText)`): if `betterduet:revived` is set → show `GUARD-3`, stop. Else `send({ type: "page:error", errorKind, targetScreenId })` where `targetScreenId` comes from the record's `menuScreenId` (or `HOME`); handle the reply; after a successful revival plan, store `betterduet:notice = "GUARD-2"` before navigating.
2. Entry page (`form1` has `form1:goHome` and no `menuform`): `send({ type: "page:entry", forms })`, keep `pageGen`.
3. Screen page (`menuform` present and `screenIdFromAction(menuform.getAttribute("action"))` non-null): `send({ type: "page:loaded", screenId, forms })`, keep `pageGen`. Update the record with `applyLoad` (consume `betterduet:pendingBack`), set `record.tabId` to the own tab ID returned by `state:get` (so duplicated tabs take ownership only after a successful load), remove `betterduet:revived`, show and remove `betterduet:notice`.
4. Anything else: `send({ type: "page:other" })`.

Handlers:

- `submit:intercepted`: wait up to `GEN_WAIT_MS` for `pageGen`; then `send({ type: "submit:request", pageGen, formId, actionName })`. `send` → post `submit:execute { rewrite: null }`; `rewrite` → post `submit:execute { rewrite: { action, viewKeyedName } }`; `notice` → post `submit:restore` and show the notice. Any exception → post `hook:disable` and `submit:execute { rewrite: null }` only if the page is still the latest per the last known gen, otherwise `submit:restore` + `GUARD-3`.
- `back:requested`: `planBack(record)`; `null` → `BACK-1`. Else store `betterduet:pendingBack = { nextIndex, target }` and `send({ type: "open:request", screenId: target, reason: "back" })`; handle the reply.
- Notice buttons: `reopen` → `open:request { screenId: record.menuScreenId, reason: "reopen" }`; `openPortal` → `window.open(SSO_PORTAL_URL, "_blank", "noopener")`.

### 7.4 landing.js (ISOLATED, /betterduet-landing*) — GUARD-002

At document_start hide the 404 (`document.documentElement.style.visibility = "hidden"`). On `DOMContentLoaded` replace the body with a centered panel `DUET を開いています…`, then make it visible.

`state:get` → `landingTarget({ from, record, ownTabId: state.tabId, loggedOut: state.loggedOut })`:

- `entry` → `open:request { screenId: HOME, reason: "entry" }`.
- `loggedOut` → render `TAB-2` in the panel.
- `screen` → if `hadDetail`, set `betterduet:notice = "GUARD-1"`; `open:request { screenId, reason: "landing" }`.

Replies via `BetterDuetNav.handleReply`; notices render in the panel. A revival on the non-entry path sets `betterduet:notice = "GUARD-2"` (overrides `GUARD-1`).

### 7.5 notice.js / notice.css (NOTICE-001)

`BetterDuetNotice.show(id, { onReopen, onOpenPortal, container })`: one `#betterduet-notice` element, inserted at the top of `#contents` (or the given container); re-showing replaces it. `role="alert"` for warning, `role="status"` for info. Text in a `<p>`, optional `<button type="button">`, close `<button type="button" aria-label="閉じる">×</button>`. Normal document flow (no overlay). Visible focus outline. Info uses a blue close to DUET's header (`#336699` family), warning uses amber with dark text; both meet WCAG AA contrast.

## 8. Known limits to keep in mind

- Tabs that were open before the extension was installed have no content scripts; their submits bypass the queue. The next extension-managed action may then hit a stale `latest`; recovery goes through GUARD-003 (entry refetch handles a live session).
- Toolbar Back on a page that never received user activation is unverified (E-026, spec "既知の制限"). Check it in E2E and record the result.

## 9. Tests

- `tests/core.test.js`: every §4 function, named with requirement IDs.
- `tests/early-hook.test.js`: run `extension/content/early-hook.js` in `node:vm` with minimal fakes (`window`, `document`, `HTMLFormElement`, `XMLHttpRequest`, `history`) to assert: logout pattern parity, that a DUET form `submit()` does not call the native submit before `submit:execute`, that `submit:execute` with `rewrite` renames the view-keyed field and sets action, and that the ack timeout falls back to native submit.
- `tests/rules.test.js`, `tests/manifest.test.js`: as in v1 (regex matches gakusei pages and the entry page, not `/kokai/`, `/front/`, `/betterduet-landing`; substitution yields `from=fb/fb010/FB01002G.html`; GET + main_frame only; permissions and host permissions exact; every referenced file exists).

## 10. Manual E2E (lead only)

Load `extension/` unpacked via the UIA helper; disable `BetterDuet Probe` and `BetterDuet DNR Test` first. Walk every acceptance criterion in this order: GUARD-001, CORE-001/003, TAB-001, TAB-002, TAB-003, TAB-004 (alive / dead), BACK-001..004 (with and without prior page interaction), GUARD-002, GUARD-003, CORE-005 (download: watch the request only; if a file would be saved, cancel), NOTICE-001 keyboard, CORE-006 + TAB-005 last (logout ends the session). Record facts as `E-0NN`, then mark requirements `Implemented` with the verification method.

## 11. Task split

| Task | Files owned | Depends on |
|---|---|---|
| A. Core | `extension/core.js`, `tests/core.test.js` | — |
| B. Manifest + rules | `extension/manifest.json`, `extension/rules.json`, `tests/rules.test.js`, `tests/manifest.test.js` | — |
| C. Service worker | `extension/background.js` | A |
| D. Content scripts | `extension/content/*`, `tests/early-hook.test.js` | A |

A and B first (parallel). C and D in parallel after A, strictly against §6.3 and §7.1. The lead audits every task against this plan and the spec.
