"use strict";

// Runs extension/background.js in node:vm with a fake chrome.* and a fake clock.
// Covers CORE-003 (one job at a time), CORE-004 / TAB-001 / TAB-002 (send, rewrite, block),
// CORE-005 (download settle), CORE-006 / TAB-005 (logout), GUARD-003 (revive and its loop guard).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Core = require("../extension/core.js");

const EXT_DIR = path.join(__dirname, "..", "extension");
const BG_PATH = path.join(EXT_DIR, "background.js");
const BG_SOURCE = fs.readFileSync(BG_PATH, "utf8");
const CORE_PATH = path.join(EXT_DIR, "core.js");
const CORE_SOURCE = fs.readFileSync(CORE_PATH, "utf8");
const STATE_KEY = "betterduet:state";

const HOME_PATH = "fb/fb020/FB02001G.html";
const NOTICES_PATH = "fb/fb017/FB01701G.html";

/** Form templates as page.js would collect them on the screen at `screenPath`. */
function formsAt(screenPath) {
    const action = "/gakusei/html/" + screenPath;
    const template = (formId, extra) => ({
        formId,
        action,
        fields: [[formId + ":__link_clicked__", ""], [formId + "/html/" + screenPath, formId], ...extra],
    });
    return {
        unloadform: template("unloadform", []),
        member: template("member", []),
        menuform: template("menuform", []),
        form1: template("form1", [["form1:token", ""]]),
    };
}

/** Lets every pending promise chain (storage writes, queue pumps) run to completion. */
async function settle() {
    for (let i = 0; i < 30; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

async function makeEnv(stored) {
    const env = { now: 1_000_000, timers: [], nextTimer: 1, store: {}, nextJob: 1 };
    if (stored) {
        env.store[STATE_KEY] = JSON.parse(JSON.stringify(stored));
    }
    const listeners = { message: null, connect: null, removed: null };

    const sandbox = {
        console,
        JSON,
        Date: { now: () => env.now },
        crypto: { randomUUID: () => "job-" + env.nextJob++ },
        setTimeout: (fn, ms) => {
            const id = env.nextTimer++;
            env.timers.push({ id, fn, due: env.now + Math.max(0, ms) });
            return id;
        },
        clearTimeout: (id) => {
            env.timers = env.timers.filter((timer) => timer.id !== id);
        },
        chrome: {
            runtime: {
                onMessage: { addListener: (fn) => (listeners.message = fn) },
                onConnect: { addListener: (fn) => (listeners.connect = fn) },
            },
            storage: {
                session: {
                    get: async (key) => (key in env.store ? { [key]: JSON.parse(JSON.stringify(env.store[key])) } : {}),
                    set: async (items) => {
                        for (const [key, value] of Object.entries(items)) {
                            env.store[key] = JSON.parse(JSON.stringify(value));
                        }
                    },
                },
            },
            tabs: { onRemoved: { addListener: (fn) => (listeners.removed = fn) } },
        },
    };
    const context = vm.createContext(sandbox);
    sandbox.importScripts = (name) => {
        assert.equal(name, "core.js");
        vm.runInContext(CORE_SOURCE, context, { filename: CORE_PATH });
    };
    vm.runInContext(BG_SOURCE, context, { filename: BG_PATH });

    /** Sends one runtime message as tab `tabId`; the promise resolves with the service worker's reply. */
    env.send = (msg, tabId, documentId) => {
        let settled = false;
        let value;
        const promise = new Promise((resolve) => {
            const sender = { tab: { id: tabId }, documentId: documentId || "doc-" + tabId };
            listeners.message(msg, sender, (reply) => {
                settled = true;
                value = reply;
                resolve(reply);
            });
        });
        promise.peek = () => (settled ? value : undefined);
        return promise;
    };
    /** Moves the clock forward and fires every timer that came due. */
    env.advance = async (ms) => {
        env.now += ms;
        const due = env.timers.filter((timer) => timer.due <= env.now);
        env.timers = env.timers.filter((timer) => timer.due > env.now);
        due.forEach((timer) => timer.fn());
        await settle();
    };
    env.removeTab = async (tabId) => {
        listeners.removed(tabId);
        await settle();
    };
    env.state = () => env.store[STATE_KEY];
    env.load = async (tabId, screenPath) => {
        const reply = await env.send(
            { type: "page:loaded", screenId: Core.screenIdFromAction(screenPath), forms: formsAt(screenPath) },
            tabId,
        );
        assert.equal(reply.type, "loaded");
        return reply.gen;
    };

    await settle();
    return env;
}

test("CORE-001: page:loaded records the latest screen and counts generations", async () => {
    const env = await makeEnv();
    assert.equal(await env.load(1, HOME_PATH), 1);
    assert.equal(await env.load(2, NOTICES_PATH), 2);
    const state = env.state();
    assert.equal(state.gen, 2);
    assert.equal(state.latest.tabId, 2);
    assert.equal(state.latest.screenId, "FB01701G");
});

test("CORE-004: a submit from the latest screen is sent as is", async () => {
    const env = await makeEnv();
    const gen = await env.load(1, HOME_PATH);
    const reply = await env.send(
        { type: "submit:request", pageGen: gen, formId: "form1", actionName: "doSomething" },
        1,
    );
    assert.equal(reply.type, "send");
    assert.equal(typeof reply.jobId, "string");
});

test("TAB-001: a common-form submit from a stale screen is rewritten to the latest screen", async () => {
    const env = await makeEnv();
    const oldGen = await env.load(1, HOME_PATH);
    await env.load(2, NOTICES_PATH);
    const reply = await env.send(
        { type: "submit:request", pageGen: oldGen, formId: "menuform", actionName: "goFb01601g" },
        1,
    );
    assert.equal(reply.type, "rewrite");
    assert.equal(reply.action, "/gakusei/html/" + NOTICES_PATH);
    assert.equal(reply.viewKeyedName, "menuform/html/" + NOTICES_PATH);
});

test("TAB-002: a form1 submit from a stale screen is blocked with NOTICE-TAB-1", async () => {
    const env = await makeEnv();
    const oldGen = await env.load(1, HOME_PATH);
    await env.load(2, NOTICES_PATH);
    const reply = await env.send(
        { type: "submit:request", pageGen: oldGen, formId: "form1", actionName: "doSomething" },
        1,
    );
    assert.deepEqual({ ...reply }, { type: "notice", id: "TAB-1" });
    assert.equal(env.state().job, null);
});

test("CORE-003: a second tab's request waits until the running navigation finishes", async () => {
    const env = await makeEnv();
    const genA = await env.load(1, HOME_PATH);
    const first = await env.send(
        { type: "submit:request", pageGen: genA, formId: "menuform", actionName: "goFb01701g" },
        1,
    );
    assert.equal(first.type, "send");

    // Tab 2 still shows the screen of generation genA as well (a duplicated tab, for example).
    const second = env.send({ type: "submit:request", pageGen: genA, formId: "menuform", actionName: "goFb01601g" }, 2);
    await settle();
    assert.equal(second.peek(), undefined, "the second request must wait for the first job");

    // Tab 1's navigation lands; the queue moves on and tab 2 is now stale, so its menu is rewritten.
    await env.load(1, NOTICES_PATH);
    const reply = await second;
    assert.equal(reply.type, "rewrite");
    assert.equal(reply.action, "/gakusei/html/" + NOTICES_PATH);
});

test("CORE-003: a navigation that never lands is released after the timeout and keeps the latest screen", async () => {
    const env = await makeEnv();
    const gen = await env.load(1, HOME_PATH);
    await env.send({ type: "submit:request", pageGen: gen, formId: "menuform", actionName: "goFb01701g" }, 1);
    const waiting = env.send({ type: "submit:request", pageGen: gen, formId: "menuform", actionName: "goFb01601g" }, 2);
    await env.advance(Core.NAV_TIMEOUT_MS - 1);
    assert.equal(waiting.peek(), undefined);
    await env.advance(1);
    assert.equal((await waiting).type, "send");
    assert.equal(env.state().latest.screenId, "FB02001G");
});

test("CORE-005: a download job ends after the settle time and keeps the latest screen", async () => {
    const env = await makeEnv();
    const gen = await env.load(1, "fb/fb170/FB17001G.html");
    const download = await env.send(
        { type: "submit:request", pageGen: gen, formId: "form1", actionName: "doDownload" },
        1,
    );
    assert.equal(download.type, "send");
    assert.equal(env.state().job.kind, "download");

    const menu = env.send({ type: "submit:request", pageGen: gen, formId: "menuform", actionName: "goFb01701g" }, 1);
    await env.advance(Core.DOWNLOAD_SETTLE_MS - 1);
    assert.equal(menu.peek(), undefined, "the menu waits while the download settles");
    await env.advance(1);
    // The server view did not move (E-022), so the same page generation is still the latest.
    assert.equal((await menu).type, "send");
    assert.equal(env.state().latest.screenId, "FB17001G");
});

test("TAB-005: after a logout XHR, submits and opens get NOTICE-TAB-2", async () => {
    const env = await makeEnv();
    const gen = await env.load(1, HOME_PATH);
    assert.equal((await env.send({ type: "xhr:logout" }, 1)).type, "ok");
    assert.equal(env.state().loggedOut, true);
    assert.equal(env.state().latest, null);

    const submit = await env.send(
        { type: "submit:request", pageGen: gen, formId: "menuform", actionName: "goFb01701g" },
        2,
    );
    assert.deepEqual({ ...submit }, { type: "notice", id: "TAB-2" });
    const open = await env.send({ type: "open:request", screenId: "FB02001G", reason: "landing" }, 2);
    assert.deepEqual({ ...open }, { type: "notice", id: "TAB-2" });
});

test("TAB-005: an entry open clears the logged-out state and revives", async () => {
    const env = await makeEnv();
    await env.send({ type: "xhr:logout" }, 1);
    const reply = await env.send({ type: "open:request", screenId: "FB02001G", reason: "entry" }, 1);
    assert.equal(reply.type, "revive");
    assert.equal(reply.targetScreenId, Core.NOTICES_SCREEN);
    assert.equal(env.state().loggedOut, false);
});

test("GUARD-002: an open request with a latest screen gets a plan from the latest forms", async () => {
    const env = await makeEnv();
    await env.load(1, NOTICES_PATH);
    const reply = await env.send({ type: "open:request", screenId: "FB01601G", reason: "landing" }, 2);
    assert.equal(reply.type, "plan");
    assert.equal(reply.plan.action, "/gakusei/html/" + NOTICES_PATH);
    assert.ok(
        reply.plan.fields.some(
            ([name, value]) => name === "menuform:__link_clicked__" && value === "menuform:goFb01601g",
        ),
    );
});

test("GUARD-003: a successful revive turns into a navigation with a plan for the target", async () => {
    const env = await makeEnv();
    const revive = await env.send({ type: "open:request", screenId: "FB01601G", reason: "landing" }, 1);
    assert.equal(revive.type, "revive");
    assert.equal(env.state().job.kind, "revive");

    const reply = await env.send(
        { type: "revive:done", jobId: revive.jobId, result: "ok", forms: formsAt(HOME_PATH) },
        1,
    );
    assert.equal(reply.type, "plan");
    assert.equal(reply.jobId, revive.jobId);
    assert.ok(reply.plan.fields.some(([, value]) => value === "menuform:goFb01601g"));
    assert.equal(env.state().job.kind, "nav");
    assert.equal(env.state().latest.screenId, "FB02001G");
});

test("GUARD-003: a revive that times out clears the latest screen and later reports are stale", async () => {
    const env = await makeEnv();
    const revive = await env.send({ type: "open:request", screenId: "FB02001G", reason: "landing" }, 1);
    await env.advance(Core.REVIVE_TIMEOUT_MS);
    assert.equal(env.state().job, null);
    assert.equal(env.state().latest, null);
    const late = await env.send(
        { type: "revive:done", jobId: revive.jobId, result: "ok", forms: formsAt(HOME_PATH) },
        1,
    );
    assert.equal(late.type, "stale");
});

test("GUARD-004: a revive that finds the SSO login gone answers NOTICE-GUARD-4", async () => {
    const env = await makeEnv();
    const revive = await env.send({ type: "open:request", screenId: "FB02001G", reason: "landing" }, 1);
    const reply = await env.send({ type: "revive:done", jobId: revive.jobId, result: "ssoExpired" }, 1);
    assert.deepEqual({ ...reply }, { type: "notice", id: "GUARD-4" });
    // The reply goes out before the job is cleared.
    await settle();
    assert.equal(env.state().job, null);
    assert.equal(env.state().latest, null);
});

test("GUARD-003: an error page right after a revival does not revive again", async () => {
    const env = await makeEnv();
    const reply = await env.send(
        { type: "page:error", errorKind: "transition", targetScreenId: "FB02001G", revived: true },
        1,
    );
    assert.deepEqual({ ...reply }, { type: "notice", id: "GUARD-3" });
    await settle();
    // No revive job was started (nothing has been written at all).
    assert.equal(env.state(), undefined);
});

test("GUARD-003: an error page revives toward the menu action the tab just sent", async () => {
    const env = await makeEnv();
    const gen = await env.load(1, HOME_PATH);
    await env.send({ type: "submit:request", pageGen: gen, formId: "menuform", actionName: "goFb01601g" }, 1);
    // The POST lands on DUET's error page instead of the FAQ.
    const reply = await env.send({ type: "page:error", errorKind: "transition", targetScreenId: "FB02001G" }, 1);
    assert.equal(reply.type, "revive");
    assert.equal(reply.targetScreenId, "FB01601G");
});

test("CORE-003: an expired job left in storage is dropped on start-up together with the latest screen", async () => {
    const stored = {
        gen: 4,
        latest: { gen: 4, tabId: 1, screenId: "FB02001G", forms: formsAt(HOME_PATH) },
        loggedOut: false,
        job: { jobId: "old", tabId: 1, docId: "doc-1", target: null, kind: "nav", deadline: 1_000_000 - 1 },
    };
    const env = await makeEnv(stored);
    assert.equal(env.state().job, null);
    assert.equal(env.state().latest, null);
    const reply = await env.send({ type: "state:get" }, 1);
    assert.equal(reply.hasLatest, false);
});

test("CORE-003: a job still running in storage is resumed on start-up and blocks the queue", async () => {
    const stored = {
        gen: 4,
        latest: { gen: 4, tabId: 1, screenId: "FB02001G", forms: formsAt(HOME_PATH) },
        loggedOut: false,
        job: { jobId: "running", tabId: 1, docId: "doc-1", target: null, kind: "nav", deadline: 1_000_000 + 5000 },
    };
    const env = await makeEnv(stored);
    const waiting = env.send({ type: "submit:request", pageGen: 4, formId: "menuform", actionName: "goFb01701g" }, 2);
    await settle();
    assert.equal(waiting.peek(), undefined);
    await env.advance(5000);
    assert.equal((await waiting).type, "send");
});

test("CORE-003: requests queued by a tab's old document are dropped when a new document speaks", async () => {
    const env = await makeEnv();
    const gen = await env.load(1, HOME_PATH);
    await env.send({ type: "submit:request", pageGen: gen, formId: "menuform", actionName: "goFb01701g" }, 1, "doc-a");
    const queued = env.send(
        { type: "submit:request", pageGen: gen, formId: "menuform", actionName: "goFb01601g" },
        2,
        "doc-old",
    );
    await settle();
    // Tab 2 reloads; its new document starts up before the queue reaches the old request.
    await env.send({ type: "state:get" }, 2, "doc-new");
    assert.equal((await queued).type, "stale");
});

test("CORE-003: closing the tab of the running job releases the queue", async () => {
    const env = await makeEnv();
    const gen = await env.load(1, HOME_PATH);
    await env.send({ type: "submit:request", pageGen: gen, formId: "menuform", actionName: "goFb01701g" }, 1);
    const waiting = env.send({ type: "submit:request", pageGen: gen, formId: "menuform", actionName: "goFb01601g" }, 2);
    await settle();
    assert.equal(waiting.peek(), undefined);
    await env.removeTab(1);
    assert.equal((await waiting).type, "send");
});

test("CORE-008: messages from outside a tab and unknown types are rejected", async () => {
    const env = await makeEnv();
    const unknown = await env.send({ type: "nope" }, 1);
    assert.equal(unknown.type, "error");
    const noTab = await env.send({ type: "state:get" }, undefined);
    assert.equal(noTab.type, "error");
});
