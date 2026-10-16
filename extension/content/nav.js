// ISOLATED world. Shared helpers for page.js and landing.js (plan 7.2). Exposes globalThis.BetterDuetNav.
(() => {
    "use strict";

    const C = globalThis.BetterDuetCore;
    const KEY_REVIVED = "betterduet:revived";
    const FORM_URLENCODED = "application/x-www-form-urlencoded";

    function isAlive() {
        return typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
    }

    // Tab-local storage. Screen IDs and notice IDs only; every access is guarded.
    const session = {
        get(key) {
            try {
                return sessionStorage.getItem(key);
            } catch (e) {
                return null;
            }
        },
        set(key, value) {
            try {
                sessionStorage.setItem(key, value);
            } catch (e) {
                // Storage can be blocked; the feature degrades silently.
            }
        },
        remove(key) {
            try {
                sessionStorage.removeItem(key);
            } catch (e) {
                // See above.
            }
        },
        getJson(key) {
            try {
                const raw = sessionStorage.getItem(key);
                return raw ? JSON.parse(raw) : null;
            } catch (e) {
                return null;
            }
        },
        setJson(key, value) {
            session.set(key, JSON.stringify(value));
        },
    };

    /**
     * Sends one message to the service worker and keeps the worker alive until the reply arrives.
     * @param {object} message
     * @returns {Promise<{ type: string }>}
     */
    async function send(message) {
        if (!isAlive()) {
            throw new Error("Extension context is gone");
        }
        let port = null;
        let timer = null;
        try {
            port = chrome.runtime.connect({ name: "keepalive" });
            timer = setInterval(() => {
                try {
                    port.postMessage({ ping: true });
                } catch (e) {
                    // The port closed; the reply may still arrive.
                }
            }, C.KEEPALIVE_MS);
        } catch (e) {
            port = null;
        }
        try {
            const reply = await chrome.runtime.sendMessage(message);
            if (!reply || typeof reply.type !== "string") {
                throw new Error("Empty reply from the service worker");
            }
            return reply;
        } finally {
            if (timer !== null) {
                clearInterval(timer);
            }
            if (port) {
                try {
                    port.disconnect();
                } catch (e) {
                    // Already closed.
                }
            }
        }
    }

    /** Posts a ready-made plan from a detached form. The isolated-world prototype is not hooked. */
    function submitPlan(plan) {
        const form = document.createElement("form");
        form.method = "post";
        form.action = plan.action;
        for (const [name, value] of plan.fields) {
            const input = document.createElement("input");
            input.type = "hidden";
            input.name = name;
            input.value = value;
            form.appendChild(input);
        }
        document.documentElement.appendChild(form);
        HTMLFormElement.prototype.submit.call(form);
    }

    /**
     * Collects the four DUET form templates. Hidden inputs only. form1 values are blanked because the
     * service worker never needs them (only the field names remain).
     */
    function collectForms(doc) {
        const forms = {};
        for (const id of C.DUET_FORM_IDS) {
            const element = doc.getElementById(id);
            if (!element || String(element.tagName).toLowerCase() !== "form") {
                continue;
            }
            const template = C.templateFromForm(element);
            if (id === "form1") {
                template.fields = template.fields.map(([name]) => [name, ""]);
            }
            forms[id] = template;
        }
        return forms;
    }

    async function fetchEntryHtml() {
        let response;
        try {
            response = await fetch(C.ENTRY_PATH, { credentials: "include", redirect: "manual" });
        } catch (e) {
            return null;
        }
        if (!response || response.type === "opaqueredirect" || !response.ok) {
            return null;
        }
        try {
            return await response.text();
        } catch (e) {
            return null;
        }
    }

    /**
     * GUARD-003 executor. Runs the entry fetch and the goHome POST, then reports to the service worker.
     * @returns {Promise<{ type: string }>} the service worker's reply to revive:done
     */
    async function revive(jobId) {
        const report = (result, forms) => {
            const message = { type: "revive:done", jobId, result };
            if (forms) {
                message.forms = forms;
            }
            return send(message);
        };

        let html = await fetchEntryHtml();
        if (html === null) {
            return report("ssoExpired");
        }
        let kind = C.classifyEntryHtml(html);
        if (kind === "duetError") {
            html = await fetchEntryHtml();
            if (html === null) {
                return report("ssoExpired");
            }
            kind = C.classifyEntryHtml(html);
        }
        if (kind !== "entry") {
            return report("ssoExpired");
        }

        const entryDoc = new DOMParser().parseFromString(html, "text/html");
        const form1 = entryDoc.getElementById("form1");
        if (!form1) {
            return report("ssoExpired");
        }
        const template = C.templateFromForm(form1);
        const body = new URLSearchParams();
        for (const [name, value] of template.fields) {
            body.append(name, name === "form1:__link_clicked__" ? "form1:goHome" : value);
        }

        let homeHtml;
        try {
            const url = new URL(template.action, location.origin + C.ENTRY_PATH).href;
            const response = await fetch(url, {
                method: "POST",
                credentials: "include",
                redirect: "manual",
                headers: { "Content-Type": FORM_URLENCODED },
                body: body.toString(),
            });
            if (!response.ok || response.type === "opaqueredirect") {
                return report("failed");
            }
            homeHtml = await response.text();
        } catch (e) {
            return report("failed");
        }

        const forms = collectForms(new DOMParser().parseFromString(homeHtml, "text/html"));
        if (!forms.unloadform || !forms.menuform) {
            // An error page, or markup we do not understand.
            return report("failed");
        }
        return report("ok", forms);
    }

    /**
     * Acts on a service worker reply.
     * @param {{ type: string }} reply
     * @param {{ onNotice?: (id: string) => void, onRevived?: (jobId: string) => void, onBeforePlan?: () => void }} [options]
     * @param {string} [revivedJobId] set internally when the reply follows a revival
     * @returns {Promise<"submitted"|"notice"|"stale"|"error"|"ignored">}
     */
    async function handleReply(reply, options, revivedJobId) {
        const opts = options || {};
        const notify = (id) => {
            if (typeof opts.onNotice === "function") {
                opts.onNotice(id);
            }
        };
        switch (reply && reply.type) {
            case "plan":
                if (!reply.plan) {
                    notify("GUARD-3");
                    return "error";
                }
                if (revivedJobId) {
                    session.set(KEY_REVIVED, revivedJobId);
                    if (typeof opts.onRevived === "function") {
                        opts.onRevived(revivedJobId);
                    }
                }
                if (typeof opts.onBeforePlan === "function") {
                    opts.onBeforePlan();
                }
                submitPlan(reply.plan);
                return "submitted";
            case "revive": {
                const next = await revive(reply.jobId);
                if (next && next.type === "stale") {
                    // The revive job is gone (timeout, tab race): never leave the page waiting.
                    notify("GUARD-3");
                    return "error";
                }
                return handleReply(next, opts, reply.jobId);
            }
            case "notice":
                notify(reply.id);
                return "notice";
            case "stale":
                return "stale";
            case "error":
                notify("GUARD-3");
                return "error";
            default:
                return "ignored";
        }
    }

    globalThis.BetterDuetNav = { isAlive, session, send, submitPlan, collectForms, revive, handleReply };
})();
