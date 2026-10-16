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
let active = null; // { jobId, tabId, kind, deadline }, mirrors state.job
let activeMeta = { target: null, reply: null }; // in-memory only: revive target and the waiting requester
let activeTimer = null;
let writeChain = Promise.resolve();
const queue = []; // { tabId, reply, run }
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
    activeTimer = setTimeout(() => {
        void onDeadline(job.jobId);
    }, Math.max(0, job.deadline - Date.now()));
}

async function startJob(kind, tabId, meta) {
    active = { jobId: crypto.randomUUID(), tabId, kind, deadline: Date.now() + jobDuration(kind) };
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
    await endActive(job.kind !== "download");
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

function enqueue(tabId, reply, run) {
    queue.push({ tabId, reply, run });
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

function dropQueuedFor(tabId) {
    for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].tabId === tabId) {
            const [item] = queue.splice(i, 1);
            item.reply({ type: "stale" });
        }
    }
}

// ---------------------------------------------------------------------------
// Decisions that run when a request reaches the head of the queue
// ---------------------------------------------------------------------------

async function replyRevive(tabId, reply, targetScreenId) {
    const target = typeof targetScreenId === "string" && targetScreenId ? targetScreenId : C.HOME;
    const jobId = await startJob("revive", tabId, { target, reply });
    reply({ type: "revive", jobId, targetScreenId: target });
}

async function runSubmit(tabId, msg, reply) {
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
    const jobId = await startJob(kind, tabId, {});
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

async function runOpen(tabId, msg, reply) {
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
            const jobId = await startJob("nav", tabId, {});
            reply({ type: "plan", jobId, plan });
            return;
        }
    }
    await replyRevive(tabId, reply, isEntry ? C.NOTICES_SCREEN : msg.screenId);
}

// ---------------------------------------------------------------------------
// Message handlers (state mutations that are not queued, plus enqueuers)
// ---------------------------------------------------------------------------

async function onPageLoaded(msg, tabId, reply) {
    if (typeof msg.screenId !== "string" || !isPlainObject(msg.forms)) {
        reply({ type: "error", message: "Invalid page:loaded payload" });
        return;
    }
    await updateState((s) => {
        s.gen += 1;
        s.latest = { gen: s.gen, tabId, screenId: msg.screenId, forms: msg.forms };
    });
    reply({ type: "loaded", gen: state.gen });
    await endNavJobOf(tabId, false);
}

async function onPageEntry(msg, tabId, reply) {
    if (!isPlainObject(msg.forms)) {
        reply({ type: "error", message: "Invalid page:entry payload" });
        return;
    }
    await updateState((s) => {
        s.loggedOut = false;
        s.gen += 1;
        s.latest = { gen: s.gen, tabId, screenId: C.ENTRY_SCREEN, forms: msg.forms };
    });
    reply({ type: "loaded", gen: state.gen });
    await endNavJobOf(tabId, false);
}

async function onPageOther(msg, tabId, reply) {
    await updateState((s) => {
        s.latest = null;
    });
    reply({ type: "ok" });
    await endNavJobOf(tabId, true);
}

async function onPageError(msg, tabId, reply) {
    // A menu action the tab just sent wins over the target the page guessed.
    const target = pendingTargets.get(tabId) || msg.targetScreenId || C.HOME;
    await endNavJobOf(tabId, false);
    if (state.loggedOut) {
        reply(noticeReply("TAB-2"));
        return;
    }
    enqueue(tabId, reply, () => replyRevive(tabId, reply, target));
}

function onSubmitRequest(msg, tabId, reply) {
    pendingTargets.delete(tabId);
    enqueue(tabId, reply, () => runSubmit(tabId, msg, reply));
}

function onOpenRequest(msg, tabId, reply) {
    enqueue(tabId, reply, () => runOpen(tabId, msg, reply));
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
    const target = activeMeta.target || C.HOME;
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
    log("message", type);
    await HANDLERS[type](msg, tabId, reply);
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
        await endActive(active.kind === "nav" || active.kind === "revive");
    }
});
