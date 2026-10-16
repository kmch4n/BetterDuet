// ISOLATED world, /betterduet-landing* (plan 7.4, GUARD-002).
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
    const KEY_NOTICE = "betterduet:notice";

    // Hide DUET's 404 body until the panel replaces it.
    try {
        document.documentElement.style.visibility = "hidden";
    } catch (e) {
        // The root element may not exist yet; the panel is shown anyway.
    }

    let panel = null;
    let status = null;

    function buildPanel() {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        document.body.style.margin = "0";
        document.body.style.fontFamily = "sans-serif";

        panel = document.createElement("main");
        panel.id = "betterduet-landing";
        panel.style.cssText =
            "box-sizing:border-box;max-width:640px;margin:20vh auto 0;padding:0 16px;text-align:center;color:#1a1a1a;";

        status = document.createElement("p");
        status.setAttribute("role", "status");
        status.style.cssText = "font-size:18px;margin:0 0 16px;";
        status.textContent = "DUET を開いています…";
        panel.appendChild(status);

        document.body.appendChild(panel);
        document.title = "DUET";
        document.documentElement.style.visibility = "";
    }

    function showNotice(id) {
        // The notice replaces the "opening" message.
        status.hidden = true;
        Notice.show(id, {
            container: panel,
            onOpenPortal: () => {
                window.open(C.SSO_PORTAL_URL, "_blank", "noopener");
            },
        });
    }

    async function run() {
        buildPanel();
        try {
            const from = new URLSearchParams(location.search).get("from");
            const state = await Nav.send({ type: "state:get" });
            const target = C.landingTarget({
                from: from,
                record: session.getJson(KEY_TAB),
                ownTabId: typeof state.tabId === "number" ? state.tabId : null,
                loggedOut: !!state.loggedOut,
            });
            log("landing", target.kind);

            if (target.kind === "loggedOut") {
                showNotice("TAB-2");
                return;
            }

            const options = { onNotice: showNotice };
            let request;
            if (target.kind === "entry") {
                request = { type: "open:request", screenId: C.HOME, reason: "entry" };
            } else {
                if (target.hadDetail) {
                    session.set(KEY_NOTICE, "GUARD-1");
                }
                // A revival on this path overrides GUARD-1.
                options.onRevived = () => session.set(KEY_NOTICE, "GUARD-2");
                request = { type: "open:request", screenId: target.screenId, reason: "landing" };
            }
            const reply = await Nav.send(request);
            const result = await Nav.handleReply(reply, options);
            if (result !== "submitted") {
                session.remove(KEY_NOTICE);
            }
        } catch (error) {
            log("landing failed", error && error.name);
            showNotice("GUARD-3");
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
        run();
    }
})();
