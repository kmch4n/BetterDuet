importScripts("core.js");
const C = globalThis.BetterDuetCore;

// Service worker: holds the latest-screen record, serializes every DUET-bound action
// through one job queue (CORE-003), and decides send / rewrite / block (CORE-004, TAB-001/002).
// It never receives form1 field values and never logs forms, fields, or tokens.

const DEBUG = false;
const STATE_KEY = "betterduet:state";

/** Logs message types, job kinds, job IDs, and screen IDs only. */
function log(...parts) {
    if (DEBUG) {
        console.log("[BetterDuet]", ...parts);
    }
}

// ---------------------------------------------------------------------------
// Pure helpers (no chrome.* access)
// ---------------------------------------------------------------------------

function initialState() {
    return { gen: 0, latest: null, loggedOut: false, job: null };
}

function jobDuration(kind) {
    if (kind === "download") {
        return C.DOWNLOAD_SETTLE_MS;
    }
    if (kind === "revive") {
        return C.REVIVE_TIMEOUT_MS;
    }
    return C.NAV_TIMEOUT_MS;
}

/** Wraps sendResponse so it fires at most once and never throws. Returns true when it actually sent. */
function makeReply(sendResponse) {
    let answered = false;
    return (payload) => {
        if (answered) {
            return false;
        }
        answered = true;
        try {
            sendResponse(payload);
        } catch (error) {
            log("reply failed");
        }
        return true;
    };
}

function noticeReply(id) {
    return { type: "notice", id };
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// State (in-memory cache mirrored to chrome.storage.session)
// ---------------------------------------------------------------------------

let state = initialState();
let active = null; // { jobId, tabId, docId, target, kind, deadline }, mirrors state.job
let activeMeta = { target: null, reply: null }; // in-memory only: the waiting requester (the revive target lives in active.target)
let activeTimer = null;
let writeChain = Promise.resolve();
const queue = []; // { tabId, docId, reply, run }
const pendingTargets = new Map(); // tabId -> screenId opened by a menu action, until that job ends
let pumping = false;

/** Applies fn to the cache at once; persistence is serialized on writeChain and never rejects. */
function updateState(fn) {
    fn(state);
    const snapshot = JSON.parse(JSON.stringify(state));
    const write = writeChain.then(() => chrome.storage.session.set({ [STATE_KEY]: snapshot }));
    writeChain = write.catch(() => log("state write failed"));
    return writeChain;
}

async function loadState() {
    let stored = null;
    try {
        const result = await chrome.storage.session.get(STATE_KEY);
        stored = result ? result[STATE_KEY] : null;
    } catch (error) {
        log("state read failed");
    }
    state = Object.assign(initialState(), isPlainObject(stored) ? stored : {});
    if (state.job) {
        if (state.job.deadline < Date.now()) {
            // Server state is unknown after an expired job; force recovery through GUARD-003.
            await updateState((s) => {
                s.job = null;
                s.latest = null;
            });
        } else {
            active = { ...state.job };
            armTimer();
        }
    }
}

const stateReady = loadState();

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

function armTimer() {
    clearTimeout(activeTimer);
    const job = active;
    if (!job) {
        return;
    }
    activeTimer = setTimeout(
        () => {
            void onDeadline(job.jobId);
        },
        Math.max(0, job.deadline - Date.now()),
    );
}

async function startJob(kind, tabId, meta) {
    active = {
        jobId: crypto.randomUUID(),
        tabId,
        docId: meta && meta.docId ? meta.docId : null,
        target: meta && meta.target ? meta.target : null,
        kind,
        deadline: Date.now() + jobDuration(kind),
    };
    activeMeta = { target: null, reply: null, ...meta };
    armTimer();
    await updateState((s) => {
        s.job = { ...active };
    });
    log("job start", kind, active.jobId);
    return active.jobId;
}

/** Turns the active revive job into a nav job with the same jobId. */
async function convertToNav() {
    active.kind = "nav";
    active.deadline = Date.now() + C.NAV_TIMEOUT_MS;
    armTimer();
    await updateState((s) => {
        s.job = { ...active };
    });
}

async function endActive(clearLatest) {
    const job = active;
    active = null;
    activeMeta = { target: null, reply: null };
    clearTimeout(activeTimer);
    if (job) {
        pendingTargets.delete(job.tabId);
        log("job end", job.kind, job.jobId);
    }
    await updateState((s) => {
        s.job = null;
        if (clearLatest) {
            s.latest = null;
        }
    });
    void pump();
}

async function expireActive() {
    const job = active;
    if (!job) {
        return;
    }
    if (job.kind === "revive" && activeMeta.reply) {
        activeMeta.reply(noticeReply("GUARD-3"));
    }
    // Downloads leave the server view untouched (E-022); everything else is now unknown.
    // A nav timeout leaves `latest` alone (CORE-003); GUARD-003 recovers if it is wrong.
    await endActive(job.kind === "revive");
}

async function onDeadline(jobId) {
    await stateReady;
    if (active && active.jobId === jobId) {
        await expireActive();
    }
}

/** The SW may have slept through a timer, so every incoming message re-checks the deadline. */
async function sweepDeadline() {
    if (active && active.deadline <= Date.now()) {
        await expireActive();
    }
}

/** Ends the active job only when it is a nav job of this tab. */
async function endNavJobOf(tabId, clearLatest) {
    if (active && active.kind === "nav" && active.tabId === tabId) {
        await endActive(clearLatest);
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

function enqueue(tabId, docId, reply, run) {
    queue.push({ tabId, docId, reply, run });
    void pump();
}

async function pump() {
    if (pumping) {
        return;
    }
    pumping = true;
    try {
        while (!active && queue.length > 0) {
            const item = queue.shift();
            try {
                await item.run();
            } catch (error) {
                log("queued run failed");
                item.reply({ type: "error", message: "Internal error" });
                if (active) {
                    await endActive(true);
                }
            }
        }
    } finally {
        pumping = false;
    }
}

/** Drops a tab's queued items; with keepDocId, only those that belong to another document. */
function dropQueuedFor(tabId, keepDocId) {
    for (let i = queue.length - 1; i >= 0; i--) {
        const item = queue[i];
        if (item.tabId !== tabId) {
            continue;
        }
        if (keepDocId === undefined || (item.docId && item.docId !== keepDocId)) {
            queue.splice(i, 1);
            item.reply({ type: "stale" });
        }
    }
}

// ---------------------------------------------------------------------------
// Decisions that run when a request reaches the head of the queue
// ---------------------------------------------------------------------------

async function replyRevive(tabId, docId, reply, targetScreenId) {
    const target = typeof targetScreenId === "string" && targetScreenId ? targetScreenId : C.HOME;
    const jobId = await startJob("revive", tabId, { target, reply, docId });
    reply({ type: "revive", jobId, targetScreenId: target });
}

async function runSubmit(tabId, docId, msg, reply) {
    const latest = state.latest;
    let decision = C.decideSubmit({
        pageGen: msg.pageGen,
        latestGen: latest ? latest.gen : -1,
        loggedOut: state.loggedOut,
        formId: msg.formId,
    });
    let rewrite = null;
    if (decision === "rewrite") {
        try {
            if (!latest || !latest.forms) {
                throw new Error("No latest screen");
            }
            rewrite = C.rewriteTemplateFor(msg.formId, latest.forms[msg.formId]);
        } catch (error) {
            decision = "block";
        }
    }

    if (decision === "loggedOut") {
        reply(noticeReply("TAB-2"));
        return;
    }
    if (decision === "block") {
        reply(noticeReply("TAB-1"));
        return;
    }

    const actionName = String(msg.actionName == null ? "" : msg.actionName);
    const kind = C.isDownloadAction(actionName) ? "download" : "nav";
    const jobId = await startJob(kind, tabId, { docId });
    const menuTarget = C.screenIdFromActionName(actionName);
    if (menuTarget) {
        pendingTargets.set(tabId, menuTarget);
    }
    if (decision === "rewrite") {
        reply({ type: "rewrite", jobId, action: rewrite.action, viewKeyedName: rewrite.viewKeyedName });
    } else {
        reply({ type: "send", jobId });
    }
}

async function runOpen(tabId, docId, msg, reply) {
    const isEntry = msg.reason === "entry";
    if (isEntry && state.loggedOut) {
        await updateState((s) => {
            s.loggedOut = false;
        });
    }
    if (state.loggedOut) {
        reply(noticeReply("TAB-2"));
        return;
    }
    if (state.latest) {
        const plan = C.buildOpenPlan(isEntry ? C.HOME : msg.screenId, state.latest.forms);
        if (plan) {
            const jobId = await startJob("nav", tabId, { docId });
            pendingTargets.set(tabId, isEntry ? C.HOME : msg.screenId);
            reply({ type: "plan", jobId, plan });
            return;
        }
    }
    await replyRevive(tabId, docId, reply, isEntry ? C.NOTICES_SCREEN : msg.screenId);
}

// ---------------------------------------------------------------------------
// Message handlers (state mutations that are not queued, plus enqueuers)
// ---------------------------------------------------------------------------

async function onPageLoaded(msg, tabId, reply) {
    if (typeof msg.screenId !== "string" || !isPlainObject(msg.forms)) {
        reply({ type: "error", message: "Invalid page:loaded payload" });
        return;
    }
    let gen = 0;
    await updateState((s) => {
        gen = ++s.gen;
        s.latest = { gen, tabId, screenId: msg.screenId, forms: msg.forms };
    });
    reply({ type: "loaded", gen });
    await endNavJobOf(tabId, false);
}

async function onPageEntry(msg, tabId, reply) {
    if (!isPlainObject(msg.forms)) {
        reply({ type: "error", message: "Invalid page:entry payload" });
        return;
    }
    let gen = 0;
    await updateState((s) => {
        s.loggedOut = false;
        gen = ++s.gen;
        s.latest = { gen, tabId, screenId: C.ENTRY_SCREEN, forms: msg.forms };
    });
    reply({ type: "loaded", gen });
    await endNavJobOf(tabId, false);
}

async function onPageOther(msg, tabId, reply) {
    await updateState((s) => {
        s.latest = null;
    });
    reply({ type: "ok" });
    await endNavJobOf(tabId, true);
}

async function onPageError(msg, tabId, reply, docId) {
    // A menu action the tab just sent wins over the target the page guessed.
    const target = pendingTargets.get(tabId) || msg.targetScreenId || C.HOME;
    await endNavJobOf(tabId, false);
    if (msg.revived === true) {
        // The page we just revived toward is itself an error page: no second revival (loop guard).
        reply(noticeReply("GUARD-3"));
        return;
    }
    if (state.loggedOut) {
        reply(noticeReply("TAB-2"));
        return;
    }
    enqueue(tabId, docId, reply, () => replyRevive(tabId, docId, reply, target));
}

function onSubmitRequest(msg, tabId, reply, docId) {
    pendingTargets.delete(tabId);
    enqueue(tabId, docId, reply, () => runSubmit(tabId, docId, msg, reply));
}

function onOpenRequest(msg, tabId, reply, docId) {
    enqueue(tabId, docId, reply, () => runOpen(tabId, docId, msg, reply));
}

async function onReviveDone(msg, tabId, reply) {
    if (!active || active.kind !== "revive" || active.jobId !== msg.jobId || active.tabId !== tabId) {
        reply({ type: "stale" });
        return;
    }
    const jobId = active.jobId;
    if (msg.result === "ssoExpired") {
        reply(noticeReply("GUARD-4"));
        await endActive(true);
        return;
    }
    if (msg.result !== "ok" || !isPlainObject(msg.forms)) {
        reply(noticeReply("GUARD-3"));
        await endActive(true);
        return;
    }
    const target = active.target || activeMeta.target || C.HOME;
    const plan = C.buildOpenPlan(target, msg.forms);
    if (!plan) {
        reply(noticeReply("GUARD-3"));
        await endActive(true);
        return;
    }
    await updateState((s) => {
        s.gen += 1;
        s.latest = { gen: s.gen, tabId: null, screenId: C.HOME, forms: msg.forms };
    });
    await convertToNav();
    reply({ type: "plan", jobId, plan });
}

async function onXhrLogout(msg, tabId, reply) {
    await updateState((s) => {
        s.loggedOut = true;
        s.latest = null;
    });
    reply({ type: "ok" });
}

async function onStateGet(msg, tabId, reply) {
    reply({ type: "state", tabId, loggedOut: state.loggedOut, hasLatest: state.latest !== null });
}

const HANDLERS = {
    "page:loaded": onPageLoaded,
    "page:entry": onPageEntry,
    "page:other": onPageOther,
    "page:error": onPageError,
    "submit:request": onSubmitRequest,
    "open:request": onOpenRequest,
    "revive:done": onReviveDone,
    "xhr:logout": onXhrLogout,
    "state:get": onStateGet,
};

const DOCUMENT_BOUND_TYPES = new Set([
    "page:loaded",
    "page:entry",
    "page:other",
    "page:error",
    "state:get",
    "open:request",
    "submit:request",
]);

/**
 * A message from a new document of a tab invalidates what the tab's older documents left behind:
 * their queued requests are dropped, and a nav job addressed to the old document ends when the new
 * document starts a request of its own. page:* messages complete the job normally and state:get is
 * only the new document starting up, so neither ends it here.
 */
async function reconcileDocument(tabId, docId, type) {
    if (!docId || !DOCUMENT_BOUND_TYPES.has(type)) {
        return;
    }
    dropQueuedFor(tabId, docId);
    const isRequest = type === "open:request" || type === "submit:request";
    if (
        isRequest &&
        active &&
        active.kind === "nav" &&
        active.tabId === tabId &&
        active.docId &&
        active.docId !== docId
    ) {
        await endActive(false);
    }
}

async function handleMessage(msg, sender, reply) {
    await stateReady;
    await sweepDeadline();
    const type = isPlainObject(msg) ? msg.type : undefined;
    if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(HANDLERS, type)) {
        reply({ type: "error", message: "Unknown message type" });
        return;
    }
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (typeof tabId !== "number") {
        reply({ type: "error", message: "Sender is not a tab" });
        return;
    }
    // documentId exists on Chrome 106+; without it the staleness checks are skipped.
    const docId = sender && typeof sender.documentId === "string" && sender.documentId ? sender.documentId : null;
    log("message", type);
    await reconcileDocument(tabId, docId, type);
    await HANDLERS[type](msg, tabId, reply, docId);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const reply = makeReply(sendResponse);
    handleMessage(msg, sender, reply).catch((error) => {
        log("handler failed");
        reply({ type: "error", message: "Internal error" });
    });
    return true;
});

// Content scripts hold this port open while they wait; the activity itself keeps the SW alive.
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "keepalive") {
        return;
    }
    port.onMessage.addListener(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
    await stateReady;
    pendingTargets.delete(tabId);
    dropQueuedFor(tabId);
    if (active && active.tabId === tabId) {
        await endActive(active.kind === "revive");
    }
});

// ---------------------------------------------------------------------------
// Settings (SET-003/007)
// ---------------------------------------------------------------------------

let rulesetChain = Promise.resolve();

/** Turns the GET-blocking ruleset on or off to match the protection switch. Calls run one at a time. */
function syncGuardRuleset() {
    rulesetChain = rulesetChain
        .then(async () => {
            const settings = await C.readSettings(chrome.storage.local);
            const ids = [C.GUARD_RULESET_ID];
            await chrome.declarativeNetRequest.updateEnabledRulesets(
                settings.protection ? { enableRulesetIds: ids } : { disableRulesetIds: ids },
            );
            log("guard ruleset", settings.protection ? "on" : "off");
        })
        .catch(() => log("ruleset sync failed"));
    return rulesetChain;
}

// An update can restore the manifest's default (enabled), so re-apply the switch on every start.
chrome.runtime.onInstalled.addListener(() => {
    void syncGuardRuleset();
});
chrome.runtime.onStartup.addListener(() => {
    void syncGuardRuleset();
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[C.SETTINGS_KEY]) {
        void syncGuardRuleset();
    }
});
