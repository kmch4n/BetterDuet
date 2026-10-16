// MAIN world, document_start. Runs before DUET's own scripts (plan 7.1).
// Cannot use core.js: the constants below are inlined and must stay identical to extension/core.js
// (tests/early-hook.test.js checks the logout pattern).
(() => {
    "use strict";

    const DUET_FORM_IDS = ["unloadform", "member", "form1", "menuform"];
    const LOGOUT_PATTERN = /unloadform(?::|%3A)__link_clicked__=unloadform(?::|%3A)closeWindow/i;
    const ACK_TIMEOUT_MS = 1500;
    // After page.js acknowledges a request it may legitimately wait for the service worker queue.
    // If it still has not answered, the request is restored (never sent natively: the page may be stale).
    const SETTLE_TIMEOUT_MS = 60000;
    // How long an issued submit suppresses popstate (a download never navigates away).
    const ISSUED_WINDOW_MS = 30000;
    const CLOSE_WINDOW_LINK = "unloadform:closeWindow";
    // DUET closes the tab as soon as the logout XHR answers, so the XHR waits for the SW to record it.
    const LOGOUT_WAIT_MS = 500;

    let enabled = true;
    let nonce = null;
    let reentry = false;
    let nextReqId = 1;
    const pending = new Map();
    const logoutWaiters = new Map();
    let submitIssued = false;

    const nativeAdd = window.addEventListener;
    const nativeSubmit = HTMLFormElement.prototype.submit;
    const nativeRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    const nativeSend = XMLHttpRequest.prototype.send;

    function isDuetForm(id) {
        return DUET_FORM_IDS.indexOf(id) >= 0;
    }

    function post(type, payload) {
        window.postMessage(Object.assign({ __betterduet: type, nonce: nonce }, payload), location.origin);
    }

    function snapshotOnclicks() {
        try {
            return Array.prototype.map.call(document.querySelectorAll("a"), (a) => [a, a.getAttribute("onclick")]);
        } catch (e) {
            return [];
        }
    }

    // ---- Submit hook (CORE-004) ----

    // DUET's ssoCloseWindow falls back to this form submit when its logout XHR fails.
    // It must reach the server natively; the logout is recorded instead.
    function isCloseWindowSubmit(form) {
        if (!form || form.id !== "unloadform") {
            return false;
        }
        const linkEl = form.elements ? form.elements["unloadform:__link_clicked__"] : null;
        return !!linkEl && String(linkEl.value) === CLOSE_WINDOW_LINK;
    }

    function intercept(form, isEvent, submitter) {
        const formId = form.id;
        const linkEl = form.elements ? form.elements[formId + ":__link_clicked__"] : null;
        // DUET clears the value right after submit() returns, so it must be read synchronously.
        const linkValue = linkEl ? String(linkEl.value) : null;
        const reqId = String(nextReqId++);
        const entry = {
            form: form,
            formId: formId,
            linkValue: linkValue,
            onclicks: snapshotOnclicks(),
            isEvent: isEvent,
            submitter: submitter || null,
            timer: null,
        };
        pending.set(reqId, entry);
        entry.timer = setTimeout(() => onTimeout(reqId), ACK_TIMEOUT_MS);
        const colon = linkValue ? linkValue.indexOf(":") : -1;
        const actionName = colon >= 0 ? linkValue.slice(colon + 1) : "";
        post("submit:intercepted", { reqId: reqId, formId: formId, actionName: actionName, isEvent: isEvent });
    }

    HTMLFormElement.prototype.submit = function submit() {
        if (enabled && isDuetForm(this.id)) {
            if (isCloseWindowSubmit(this)) {
                post("xhr:logout", {});
                return nativeSubmit.apply(this, arguments);
            }
            intercept(this, false, null);
            return undefined;
        }
        return nativeSubmit.apply(this, arguments);
    };

    document.addEventListener(
        "submit",
        (event) => {
            const form = event.target;
            if (!enabled || reentry || !form || !isDuetForm(form.id)) {
                return;
            }
            if (isCloseWindowSubmit(form)) {
                post("xhr:logout", {});
                return;
            }
            event.preventDefault();
            // Page handlers run when the request is replayed through requestSubmit().
            event.stopImmediatePropagation();
            intercept(form, true, event.submitter);
        },
        true
    );

    function perform(entry, rewrite) {
        submitIssued = true;
        setTimeout(() => {
            submitIssued = false;
        }, ISSUED_WINDOW_MS);
        const form = entry.form;
        const linkEl = form.elements ? form.elements[entry.formId + ":__link_clicked__"] : null;
        if (linkEl && entry.linkValue !== null) {
            linkEl.value = entry.linkValue;
        }
        if (rewrite) {
            form.action = rewrite.action;
            const prefix = entry.formId + "/";
            const hidden = Array.prototype.filter.call(form.elements || [], (el) => {
                return el.type === "hidden" && typeof el.name === "string" && el.name.indexOf(prefix) === 0;
            });
            if (hidden.length > 0) {
                hidden[0].name = rewrite.viewKeyedName;
            }
        }
        if (entry.isEvent && nativeRequestSubmit) {
            reentry = true;
            try {
                nativeRequestSubmit.call(form, entry.submitter);
            } catch (e) {
                nativeSubmit.call(form);
            } finally {
                reentry = false;
            }
        } else {
            nativeSubmit.call(form);
        }
    }

    function restore(entry) {
        // DUET disables links synchronously after submit() returns; undo it afterwards.
        setTimeout(() => {
            window.mMOnceTimeFlg = true;
            for (const pair of entry.onclicks) {
                try {
                    if (pair[1] === null) {
                        pair[0].removeAttribute("onclick");
                    } else {
                        pair[0].setAttribute("onclick", pair[1]);
                    }
                } catch (e) {
                    // The element may be gone.
                }
            }
            if (window.jQuery) {
                window.jQuery("*").css("cursor", "");
            }
        }, 0);
    }

    function take(reqId) {
        const entry = pending.get(String(reqId));
        if (entry) {
            clearTimeout(entry.timer);
            pending.delete(String(reqId));
        }
        return entry || null;
    }

    function onTimeout(reqId) {
        const entry = take(reqId);
        if (!entry) {
            return;
        }
        // page.js never acknowledged (gone or broken): behave like plain DUET from now on.
        enabled = false;
        perform(entry, null);
    }

    function onSettleTimeout(reqId) {
        // page.js acknowledged but never settled the request: undo DUET's lock and keep the hook on.
        const entry = take(reqId);
        if (entry) {
            restore(entry);
        }
    }

    // ---- Channel from the ISOLATED world ----

    nativeAdd.call(window, "message", (event) => {
        if (event.source !== window) {
            return;
        }
        const data = event.data;
        if (!data || typeof data !== "object" || typeof data.__betterduet !== "string") {
            return;
        }
        if (!nonce || data.nonce !== nonce) {
            return;
        }
        let entry;
        switch (data.__betterduet) {
            case "submit:ack":
                entry = pending.get(String(data.reqId));
                if (entry) {
                    clearTimeout(entry.timer);
                    entry.timer = setTimeout(() => onSettleTimeout(data.reqId), SETTLE_TIMEOUT_MS);
                }
                break;
            case "submit:execute":
                entry = take(data.reqId);
                if (entry) {
                    perform(entry, data.rewrite || null);
                }
                break;
            case "submit:restore":
                entry = take(data.reqId);
                if (entry) {
                    restore(entry);
                }
                break;
            case "logout:ack":
                if (logoutWaiters.has(String(data.reqId))) {
                    logoutWaiters.get(String(data.reqId))();
                }
                break;
            case "nav:prepare":
                // DUET's _doAction3 clears forceClose before it submits; plan submits skip that path.
                window.forceClose = false;
                break;
            case "hook:disable":
                enabled = false;
                break;
            default:
                break;
        }
    });

    // First init wins. page.js re-sends it when it sees "betterduet:hook-ready", so the order of the
    // two document_start scripts does not matter.
    document.addEventListener("betterduet:init", (event) => {
        if (!nonce && event && typeof event.detail === "string" && event.detail) {
            nonce = event.detail;
        }
    });
    document.dispatchEvent(new CustomEvent("betterduet:hook-ready"));

    // ---- Popstate (BACK-001/002) ----

    window.addEventListener = function addEventListener(type, listener, options) {
        const onWindow = this === window || this === undefined || this === null;
        if (enabled && type === "popstate" && onWindow) {
            return undefined;
        }
        return nativeAdd.call(onWindow ? window : this, type, listener, options);
    };

    nativeAdd.call(window, "popstate", () => {
        if (!enabled) {
            return;
        }
        history.pushState("push", null, null);
        // Mirrors DUET's own flag in global.js: no back while a submit is pending in this document.
        if (pending.size > 0 || submitIssued) {
            return;
        }
        post("back:requested", {});
    });

    // ---- Alt+Left (BACK-004) ----

    nativeAdd.call(
        window,
        "keydown",
        (event) => {
            if (enabled && event.altKey && event.key === "ArrowLeft" && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
                event.stopPropagation();
            }
        },
        true
    );

    // ---- Logout (CORE-006) ----

    function announceLogout(then) {
        const id = String(nextReqId++);
        let done = false;
        const finish = () => {
            if (done) {
                return;
            }
            done = true;
            logoutWaiters.delete(id);
            then();
        };
        logoutWaiters.set(id, finish);
        setTimeout(finish, LOGOUT_WAIT_MS);
        post("xhr:logout", { reqId: id });
        if (!enabled || !nonce) {
            finish();
        }
    }

    XMLHttpRequest.prototype.send = function send(body) {
        let isLogout = false;
        try {
            isLogout = typeof body === "string" && LOGOUT_PATTERN.test(body);
        } catch (e) {
            // Never break DUET's request.
        }
        if (isLogout) {
            const xhr = this;
            const args = arguments;
            announceLogout(() => nativeSend.apply(xhr, args));
            return undefined;
        }
        return nativeSend.apply(this, arguments);
    };
})();
