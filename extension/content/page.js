// ISOLATED world, /gakusei/html/* (plan 7.3).
(() => {
    "use strict";

    const C = globalThis.BetterDuetCore;
    const Nav = globalThis.BetterDuetNav;
    const Notice = globalThis.BetterDuetNotice;
    const session = Nav.session;

    const DEBUG = false;
    const log = (...args) => {
        if (DEBUG) {
            console.debug("[BetterDuet]", ...args);
        }
    };

    const KEY_TAB = "betterduet:tab";
    const KEY_PENDING_BACK = "betterduet:pendingBack";
    const KEY_NOTICE = "betterduet:notice";
    const KEY_REVIVED = "betterduet:revived";
    const ALIVE_CHECK_MS = 5000;

    const nonce = crypto.randomUUID();
    let ownTabId = null;
    let hookDisabled = false;
    let backBusy = false;

    // ---- Channel to the MAIN world hook (plan 7.1) ----

    function post(type, payload) {
        window.postMessage(Object.assign({ __betterduet: type, nonce: nonce }, payload), location.origin);
    }

    function sendInit() {
        document.dispatchEvent(new CustomEvent("betterduet:init", { detail: nonce }));
    }

    function disableHook() {
        if (!hookDisabled) {
            hookDisabled = true;
            post("hook:disable", {});
        }
    }

    // Whichever document_start script runs first, the hook gets the nonce.
    document.addEventListener("betterduet:hook-ready", sendInit);
    sendInit();

    function ensureAlive() {
        if (!Nav.isAlive()) {
            disableHook();
            throw new Error("Extension context is gone");
        }
    }

    const aliveTimer = setInterval(() => {
        if (!Nav.isAlive()) {
            clearInterval(aliveTimer);
            disableHook();
        }
    }, ALIVE_CHECK_MS);

    // ---- Page generation (set after page:loaded / page:entry) ----

    let genSettled = false;
    let pageGen = null;
    let resolveGen = null;
    const genPromise = new Promise((resolve) => {
        resolveGen = resolve;
    });

    function settleGen(value) {
        if (!genSettled) {
            genSettled = true;
            pageGen = value;
            resolveGen(value);
        }
    }

    async function waitForGen() {
        if (genSettled) {
            return pageGen;
        }
        let timer = null;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), C.GEN_WAIT_MS);
        });
        const value = await Promise.race([genPromise, timeout]);
        clearTimeout(timer);
        return value;
    }

    // ---- Notices and navigation helpers ----

    function showNotice(id) {
        return Notice.show(id, {
            onReopen: reopen,
            onOpenPortal: () => {
                window.open(C.SSO_PORTAL_URL, "_blank", "noopener");
            },
        });
    }

    const replyOptions = {
        onNotice: showNotice,
        // A revival always shows GUARD-2 on the page that follows.
        onRevived: () => session.set(KEY_NOTICE, "GUARD-2"),
        // DUET's own _doAction3 clears forceClose before submitting (nav:prepare is MAIN-world only).
        onBeforePlan: () => post("nav:prepare", {}),
    };

    async function reopen() {
        ensureAlive();
        const record = session.getJson(KEY_TAB);
        const screenId = record && record.menuScreenId ? record.menuScreenId : C.HOME;
        const reply = await Nav.send({ type: "open:request", screenId: screenId, reason: "reopen" });
        await Nav.handleReply(reply, replyOptions);
    }

    // ---- Page classification ----

    function isEntryPage() {
        if (document.getElementById("menuform") || !document.getElementById("form1")) {
            return false;
        }
        return C.classifyEntryHtml(document.documentElement.outerHTML) === "entry";
    }

    async function onLoaded() {
        try {
            const state = await Nav.send({ type: "state:get" });
            ownTabId = typeof state.tabId === "number" ? state.tabId : null;

            const menuform = document.getElementById("menuform");
            const screenId = menuform ? C.screenIdFromAction(menuform.getAttribute("action")) : null;

            // 1. Error page (plan 7.3 order). Error pages have no #menu sidebar; a normal screen such as
            // the FAQ may contain the phrases in its body text.
            const errorKind = document.getElementById("menu")
                ? null
                : C.classifyErrorText(document.body ? document.body.innerText : "");
            if (errorKind) {
                settleGen(null);
                const record = session.getJson(KEY_TAB);
                const target = record && record.menuScreenId ? record.menuScreenId : C.HOME;
                if (session.get(KEY_REVIVED)) {
                    session.remove(KEY_REVIVED);
                    showNotice("GUARD-3");
                    // Tell the service worker so this tab's nav job ends; it must not revive again.
                    await Nav.send({
                        type: "page:error",
                        errorKind: errorKind,
                        targetScreenId: target,
                        revived: true,
                    }).catch(() => {});
                    return;
                }
                const reply = await Nav.send({ type: "page:error", errorKind: errorKind, targetScreenId: target });
                await Nav.handleReply(reply, replyOptions);
                return;
            }

            // 2. Entry page shown directly.
            if (isEntryPage()) {
                const reply = await Nav.send({ type: "page:entry", forms: Nav.collectForms(document) });
                session.remove(KEY_REVIVED);
                settleGen(reply.gen);
                return;
            }

            // 3. Screen page.
            if (screenId) {
                const pendingBack = session.getJson(KEY_PENDING_BACK);
                const reply = await Nav.send({
                    type: "page:loaded",
                    screenId: screenId,
                    forms: Nav.collectForms(document),
                });
                settleGen(reply.gen);
                session.remove(KEY_PENDING_BACK);
                session.remove(KEY_REVIVED);
                const record = C.applyLoad(session.getJson(KEY_TAB), {
                    tabId: ownTabId,
                    screenId: screenId,
                    pendingBack: pendingBack,
                });
                session.setJson(KEY_TAB, record);
                const noticeId = session.get(KEY_NOTICE);
                if (noticeId) {
                    session.remove(KEY_NOTICE);
                    showNotice(noticeId);
                }
                log("loaded", screenId, reply.gen);
                return;
            }

            // 4. Anything else.
            settleGen(null);
            await Nav.send({ type: "page:other" });
        } catch (error) {
            // Never block the page: submits fall back to native behaviour through the exception path.
            settleGen(null);
            log("load failed", error && error.name);
        }
    }

    // ---- Handlers for messages from the hook ----

    async function onIntercepted(data) {
        const reqId = data.reqId;
        post("submit:ack", { reqId: reqId });
        try {
            ensureAlive();
            const gen = await waitForGen();
            if (gen === null) {
                throw new Error("Page generation is unknown");
            }
            const reply = await Nav.send({
                type: "submit:request",
                pageGen: gen,
                formId: data.formId,
                actionName: data.actionName,
            });
            if (reply.type === "send") {
                post("submit:execute", { reqId: reqId, rewrite: null });
            } else if (reply.type === "rewrite") {
                post("submit:execute", {
                    reqId: reqId,
                    rewrite: { action: reply.action, viewKeyedName: reply.viewKeyedName },
                });
            } else if (reply.type === "notice") {
                post("submit:restore", { reqId: reqId });
                showNotice(reply.id);
            } else {
                throw new Error("Unexpected reply: " + reply.type);
            }
        } catch (error) {
            log("submit failed", error && error.name);
            if (!Nav.isAlive()) {
                // P-5: the extension is gone, so behave like plain DUET.
                disableHook();
                post("submit:execute", { reqId: reqId, rewrite: null });
            } else {
                // The extension is alive but could not decide: the page may be stale, so never send its POST.
                post("submit:restore", { reqId: reqId });
                showNotice("GUARD-3");
            }
        }
    }

    async function onBack() {
        if (backBusy) {
            return;
        }
        backBusy = true;
        try {
            ensureAlive();
            const plan = C.planBack(session.getJson(KEY_TAB));
            if (!plan) {
                showNotice("BACK-1");
                return;
            }
            session.setJson(KEY_PENDING_BACK, { nextIndex: plan.nextIndex, target: plan.targetScreenId });
            const reply = await Nav.send({ type: "open:request", screenId: plan.targetScreenId, reason: "back" });
            const result = await Nav.handleReply(reply, replyOptions);
            if (result !== "submitted") {
                session.remove(KEY_PENDING_BACK);
            }
        } catch (error) {
            session.remove(KEY_PENDING_BACK);
            log("back failed", error && error.name);
        } finally {
            backBusy = false;
        }
    }

    function onLogout() {
        Nav.send({ type: "xhr:logout" }).catch(() => {});
    }

    window.addEventListener("message", (event) => {
        if (event.source !== window) {
            return;
        }
        const data = event.data;
        if (!data || typeof data !== "object" || typeof data.__betterduet !== "string" || data.nonce !== nonce) {
            return;
        }
        switch (data.__betterduet) {
            case "submit:intercepted":
                onIntercepted(data);
                break;
            case "back:requested":
                onBack();
                break;
            case "xhr:logout":
                onLogout();
                break;
            default:
                break;
        }
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", onLoaded, { once: true });
    } else {
        onLoaded();
    }
})();
