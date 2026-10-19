"use strict";

// Runs extension/content/early-hook.js in node:vm with small fakes (plan section 9).
// Covers CORE-004 (submit hook), CORE-006 (logout pattern), BACK-001/002 (popstate).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Core = require("../extension/core.js");

const HOOK_PATH = path.join(__dirname, "..", "extension", "content", "early-hook.js");
const HOOK_SOURCE = fs.readFileSync(HOOK_PATH, "utf8");
const NONCE = "test-nonce";
const LINK = "menuform:__link_clicked__";

function makeEnv() {
    const env = { posted: [], nativeSubmits: [], pushStates: [], timers: [], nextTimer: 1 };

    const addTo = (target) => {
        target.__listeners = {};
        target.addEventListener = function (type, fn) {
            (this.__listeners[type] = this.__listeners[type] || []).push(fn);
        };
    };

    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.location = { origin: "https://duet.doshisha.ac.jp" };
    sandbox.postMessage = (message, origin) => env.posted.push({ message, origin });
    addTo(sandbox);

    const anchors = [];
    sandbox.document = {
        anchors,
        querySelectorAll: () => anchors,
        dispatchEvent(event) {
            for (const fn of this.__listeners[event.type] || []) {
                fn(event);
            }
        },
    };
    addTo(sandbox.document);

    sandbox.CustomEvent = class {
        constructor(type, init) {
            this.type = type;
            this.detail = init ? init.detail : undefined;
        }
    };
    sandbox.HTMLFormElement = function HTMLFormElement() {};
    sandbox.HTMLFormElement.prototype.submit = function () {
        env.nativeSubmits.push({
            form: this,
            action: this.action,
            link: this.elements[this.id + ":__link_clicked__"].value,
        });
    };
    sandbox.XMLHttpRequest = function XMLHttpRequest() {};
    sandbox.XMLHttpRequest.prototype.send = function (body) {
        env.xhrBodies = (env.xhrBodies || []).concat([body]);
    };
    sandbox.history = { pushState: (...args) => env.pushStates.push(args) };
    sandbox.setTimeout = (fn, ms) => {
        const id = env.nextTimer++;
        env.timers.push({ id, fn, ms });
        return id;
    };
    sandbox.clearTimeout = (id) => {
        env.timers = env.timers.filter((timer) => timer.id !== id);
    };

    env.sandbox = sandbox;
    // Fires (and removes) every pending timer whose delay is at most maxMs.
    env.flush = (maxMs) => {
        const due = env.timers.filter((timer) => timer.ms <= maxMs);
        env.timers = env.timers.filter((timer) => timer.ms > maxMs);
        due.forEach((timer) => timer.fn());
    };
    // Delivers a message from the ISOLATED world to the hook.
    env.deliver = (type, payload) => {
        const data = Object.assign({ __betterduet: type, nonce: NONCE }, payload);
        for (const fn of sandbox.__listeners.message || []) {
            fn({ source: env.win, data });
        }
    };
    env.sent = (type) => env.posted.map((p) => p.message).filter((m) => m.__betterduet === type);

    const context = vm.createContext(sandbox);
    // Inside the context, `window` is the global proxy, not the sandbox object; the hook compares against it.
    env.win = vm.runInContext("window", context);
    vm.runInContext(HOOK_SOURCE, context, { filename: HOOK_PATH });
    sandbox.document.dispatchEvent({ type: "betterduet:init", detail: NONCE });
    return env;
}

function makeForm(env, id, actionName) {
    const form = Object.create(env.sandbox.HTMLFormElement.prototype);
    const link = { type: "hidden", name: id + ":__link_clicked__", value: id + ":" + actionName };
    const view = { type: "hidden", name: id + "/html/fb/fb020/FB02001G.html", value: id };
    const other = { type: "hidden", name: "form1:token", value: "t" };
    form.id = id;
    form.action = "/gakusei/html/fb/fb020/FB02001G.html";
    form.elements = [link, view, other];
    form.elements[link.name] = link;
    return { form, link, view, other };
}

test("CORE-006: the inlined logout pattern equals BetterDuetCore.LOGOUT_PATTERN", () => {
    const match = /const LOGOUT_PATTERN = \/(.+)\/i;/.exec(HOOK_SOURCE);
    assert.ok(match, "LOGOUT_PATTERN literal not found in early-hook.js");
    assert.equal(match[1], Core.LOGOUT_PATTERN.source);
    assert.equal(Core.LOGOUT_PATTERN.flags, "i");
});

test("CORE-004: the inlined DUET_FORM_IDS equals BetterDuetCore.DUET_FORM_IDS", () => {
    const match = /const DUET_FORM_IDS = (\[[^\]]*\]);/.exec(HOOK_SOURCE);
    assert.ok(match, "DUET_FORM_IDS literal not found in early-hook.js");
    assert.deepEqual(JSON.parse(match[1]), [...Core.DUET_FORM_IDS]);
});

test("CORE-004: the inlined ACK_TIMEOUT_MS equals BetterDuetCore.ACK_TIMEOUT_MS", () => {
    const match = /const ACK_TIMEOUT_MS = (\d+);/.exec(HOOK_SOURCE);
    assert.ok(match, "ACK_TIMEOUT_MS literal not found in early-hook.js");
    assert.equal(Number(match[1]), Core.ACK_TIMEOUT_MS);
});

test("CORE-006: a logout XHR waits for logout:ack, other XHRs send at once", () => {
    const env = makeEnv();
    const xhr = new env.sandbox.XMLHttpRequest();
    xhr.send("unloadform%3A__link_clicked__=unloadform%3AcloseWindow&x=1");
    xhr.send("form1%3Atoken=abc");
    const [logout] = env.sent("xhr:logout");
    assert.ok(logout, "xhr:logout was not posted");
    assert.deepEqual(env.xhrBodies, ["form1%3Atoken=abc"]);
    env.deliver("logout:ack", { reqId: logout.reqId });
    assert.equal(env.xhrBodies.length, 2);
    env.flush(1000);
    assert.equal(env.xhrBodies.length, 2, "the timeout must not send the XHR twice");
});

test("CORE-006: a logout XHR is sent after 500 ms even without an ack", () => {
    const env = makeEnv();
    const xhr = new env.sandbox.XMLHttpRequest();
    xhr.send("unloadform%3A__link_clicked__=unloadform%3AcloseWindow");
    assert.equal((env.xhrBodies || []).length, 0);
    env.flush(500);
    assert.equal(env.xhrBodies.length, 1);
});

test("CORE-004: submit() on a DUET form is held until submit:execute", () => {
    const env = makeEnv();
    const { form, link } = makeForm(env, "menuform", "goFb17001g");
    form.submit();
    // DUET clears the link value right after submit() returns.
    link.value = "";

    assert.equal(env.nativeSubmits.length, 0);
    const [request] = env.sent("submit:intercepted");
    assert.equal(request.nonce, NONCE);
    assert.equal(request.formId, "menuform");
    assert.equal(request.actionName, "goFb17001g");
    assert.equal(request.isEvent, false);
    assert.equal(env.posted[0].origin, "https://duet.doshisha.ac.jp");

    env.deliver("submit:execute", { reqId: request.reqId, rewrite: null });
    assert.equal(env.nativeSubmits.length, 1);
    assert.equal(env.nativeSubmits[0].link, "menuform:goFb17001g");
});

test("CORE-004: submit() on a non-DUET form goes straight to the native submit", () => {
    const env = makeEnv();
    const { form } = makeForm(env, "other", "x");
    form.submit();
    assert.equal(env.nativeSubmits.length, 1);
    assert.equal(env.sent("submit:intercepted").length, 0);
});

test("TAB-001: submit:execute with rewrite sets the action and renames only the view-keyed field", () => {
    const env = makeEnv();
    const { form, view, other } = makeForm(env, "menuform", "goFb01601g");
    form.submit();
    const [request] = env.sent("submit:intercepted");

    env.deliver("submit:execute", {
        reqId: request.reqId,
        rewrite: { action: "/gakusei/html/fb/fb017/FB01701G.html", viewKeyedName: "menuform/html/fb/fb017/FB01701G.html" },
    });

    assert.equal(env.nativeSubmits.length, 1);
    assert.equal(form.action, "/gakusei/html/fb/fb017/FB01701G.html");
    assert.equal(view.name, "menuform/html/fb/fb017/FB01701G.html");
    assert.equal(other.name, "form1:token");
});

test("CORE-004: messages with a wrong nonce or foreign source are ignored", () => {
    const env = makeEnv();
    const { form } = makeForm(env, "menuform", "goHome");
    form.submit();
    const [request] = env.sent("submit:intercepted");

    for (const fn of env.sandbox.__listeners.message) {
        fn({ source: {}, data: { __betterduet: "submit:execute", nonce: NONCE, reqId: request.reqId } });
        fn({ source: env.win, data: { __betterduet: "submit:execute", nonce: "wrong", reqId: request.reqId } });
    }
    assert.equal(env.nativeSubmits.length, 0);
});

test("CORE-004: without any answer the ack timeout disables the hook and submits natively", () => {
    const env = makeEnv();
    const { form, link } = makeForm(env, "menuform", "goFb17001g");
    form.submit();
    link.value = "";
    assert.equal(env.nativeSubmits.length, 0);

    env.flush(1500);
    assert.equal(env.nativeSubmits.length, 1);
    assert.equal(env.nativeSubmits[0].link, "menuform:goFb17001g");

    // The hook is now off: later submits are native and nothing is intercepted.
    form.submit();
    assert.equal(env.nativeSubmits.length, 2);
    assert.equal(env.sent("submit:intercepted").length, 1);
});

test("CORE-004: submit:ack keeps the request waiting past the ack timeout", () => {
    const env = makeEnv();
    const { form } = makeForm(env, "menuform", "goHome");
    form.submit();
    const [request] = env.sent("submit:intercepted");
    env.deliver("submit:ack", { reqId: request.reqId });

    env.flush(1500);
    assert.equal(env.nativeSubmits.length, 0);
    env.deliver("submit:execute", { reqId: request.reqId, rewrite: null });
    assert.equal(env.nativeSubmits.length, 1);
});

test("TAB-002: submit:restore re-enables links, the once-flag and cursors without submitting", () => {
    const env = makeEnv();
    const calls = [];
    const had = { setAttribute: (n, v) => calls.push(["set", n, v]), removeAttribute: (n) => calls.push(["remove", n]) };
    const pair = (value) => Object.assign({ getAttribute: () => value }, had);
    env.sandbox.document.anchors.push(pair("doAction()"), pair(null));
    let cursor = null;
    env.sandbox.jQuery = () => ({ css: (name, value) => (cursor = [name, value]) });

    const { form } = makeForm(env, "form1", "doSomething");
    form.submit();
    const [request] = env.sent("submit:intercepted");
    env.deliver("submit:restore", { reqId: request.reqId });
    env.flush(0);

    assert.equal(env.nativeSubmits.length, 0);
    assert.equal(env.sandbox.mMOnceTimeFlg, true);
    assert.deepEqual(calls, [["set", "onclick", "doAction()"], ["remove", "onclick"]]);
    assert.deepEqual(cursor, ["cursor", ""]);
});

test("BACK-001: a page popstate registration is dropped, the hook's own one stays", () => {
    const env = makeEnv();
    const pageListener = () => {};
    env.win.addEventListener("popstate", pageListener);
    env.win.addEventListener("pageshow", pageListener);

    const popstate = env.sandbox.__listeners.popstate;
    assert.equal(popstate.length, 1);
    assert.notEqual(popstate[0], pageListener);
    assert.deepEqual(env.sandbox.__listeners.pageshow, [pageListener]);
});

test("BACK-002: popstate pushes a history entry and posts back:requested", () => {
    const env = makeEnv();
    env.sandbox.__listeners.popstate[0]({});
    assert.deepEqual(env.pushStates, [["push", null, null]]);
    assert.equal(env.sent("back:requested").length, 1);
});

test("BACK-004: Alt+Left is stopped, other keys are not", () => {
    const env = makeEnv();
    const [onKeydown] = env.sandbox.__listeners.keydown;
    const press = (init) => {
        let stopped = false;
        onKeydown(Object.assign({ stopPropagation: () => (stopped = true) }, init));
        return stopped;
    };
    assert.equal(press({ altKey: true, key: "ArrowLeft" }), true);
    assert.equal(press({ altKey: true, key: "ArrowRight" }), false);
    assert.equal(press({ altKey: true, ctrlKey: true, key: "ArrowLeft" }), false);
    assert.equal(press({ altKey: false, key: "ArrowLeft" }), false);
});

test("CORE-004: hook:disable makes later popstate registrations and submits pass through", () => {
    const env = makeEnv();
    env.deliver("hook:disable", {});
    const pageListener = () => {};
    env.win.addEventListener("popstate", pageListener);
    assert.ok(env.sandbox.__listeners.popstate.includes(pageListener));

    const { form } = makeForm(env, "menuform", "goHome");
    form.submit();
    assert.equal(env.nativeSubmits.length, 1);
});

test("CORE-004: after submit:ack the 60 s fallback restores instead of submitting natively", () => {
    const env = makeEnv();
    const { form } = makeForm(env, "menuform", "goHome");
    form.submit();
    const [request] = env.sent("submit:intercepted");
    env.deliver("submit:ack", { reqId: request.reqId });

    env.flush(60000);
    env.flush(0);
    assert.equal(env.nativeSubmits.length, 0);
    assert.equal(env.sandbox.mMOnceTimeFlg, true);

    // The hook stays enabled: the next submit is intercepted again.
    form.submit();
    assert.equal(env.sent("submit:intercepted").length, 2);
    assert.equal(env.nativeSubmits.length, 0);
});

test("CORE-006: the unloadform closeWindow fallback submits natively and posts xhr:logout", () => {
    const env = makeEnv();
    const { form } = makeForm(env, "unloadform", "closeWindow");
    form.submit();
    assert.equal(env.nativeSubmits.length, 1);
    assert.equal(env.nativeSubmits[0].link, "unloadform:closeWindow");
    assert.equal(env.sent("submit:intercepted").length, 0);
    assert.equal(env.sent("xhr:logout").length, 1);

    // Other unloadform actions are still intercepted.
    const other = makeForm(env, "unloadform", "somethingElse");
    other.form.submit();
    assert.equal(env.sent("submit:intercepted").length, 1);
    assert.equal(env.nativeSubmits.length, 1);
});

test("BACK-002: popstate is re-pushed but ignored while a submit is pending or issued", () => {
    const env = makeEnv();
    const { form } = makeForm(env, "menuform", "goHome");
    form.submit();
    const [request] = env.sent("submit:intercepted");

    env.sandbox.__listeners.popstate[0]({});
    assert.equal(env.pushStates.length, 1);
    assert.equal(env.sent("back:requested").length, 0);

    env.deliver("submit:execute", { reqId: request.reqId, rewrite: null });
    env.sandbox.__listeners.popstate[0]({});
    assert.equal(env.pushStates.length, 2);
    assert.equal(env.sent("back:requested").length, 0);
});

/** Submits `form` through the hook and lets page.js answer "send". */
function submitAndExecute(env, form) {
    const before = env.sent("submit:intercepted").length;
    form.submit();
    const request = env.sent("submit:intercepted")[before];
    env.deliver("submit:execute", { reqId: request.reqId, rewrite: null });
}

const popstate = (env) => env.sandbox.__listeners.popstate[0]({});

test("BACK-002: after a download, Back works again once the 3 s settle time has passed", () => {
    const env = makeEnv();
    submitAndExecute(env, makeForm(env, "form1", "doDownload").form);
    popstate(env);
    assert.equal(env.sent("back:requested").length, 0);

    env.flush(Core.DOWNLOAD_SETTLE_MS);
    popstate(env);
    assert.equal(env.sent("back:requested").length, 1);
});

test("BACK-002: after a navigating submit, Back stays suppressed for the full 30 s", () => {
    const env = makeEnv();
    submitAndExecute(env, makeForm(env, "menuform", "goFb01701g").form);
    env.flush(Core.DOWNLOAD_SETTLE_MS);
    popstate(env);
    assert.equal(env.sent("back:requested").length, 0);

    env.flush(30000);
    popstate(env);
    assert.equal(env.sent("back:requested").length, 1);
});

test("BACK-002: an earlier download's timer does not lift a later submit's suppression", () => {
    const env = makeEnv();
    submitAndExecute(env, makeForm(env, "form1", "doDownload").form);
    submitAndExecute(env, makeForm(env, "menuform", "goFb01701g").form);
    env.flush(Core.DOWNLOAD_SETTLE_MS);
    popstate(env);
    assert.equal(env.sent("back:requested").length, 0);
});

test("CORE-005: the inlined DOWNLOAD_SETTLE_MS equals BetterDuetCore.DOWNLOAD_SETTLE_MS", () => {
    const match = /const DOWNLOAD_SETTLE_MS = (\d+);/.exec(HOOK_SOURCE);
    assert.ok(match, "DOWNLOAD_SETTLE_MS literal not found in early-hook.js");
    assert.equal(Number(match[1]), Core.DOWNLOAD_SETTLE_MS);
});

test("CORE-004: nav:prepare clears DUET's forceClose flag", () => {
    const env = makeEnv();
    env.sandbox.forceClose = true;
    env.deliver("nav:prepare", {});
    assert.equal(env.sandbox.forceClose, false);
});
