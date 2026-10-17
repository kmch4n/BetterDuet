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
    const KEY_SSO_TRIED = "betterduet:ssoTried";

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

        // A single DUET-style block (NOTICE-002): blue heading band, white message box.
        panel = document.createElement("main");
        panel.id = "betterduet-landing";
        panel.className = "bd-scope bd-landing";

        status = document.createElement("div");
        status.className = "bd-notice";
        const head = document.createElement("div");
        head.className = "bd-notice__head";
        const title = document.createElement("h1");
        title.className = "bd-notice__title";
        title.textContent = "DUET";
        head.appendChild(title);
        status.appendChild(head);
        const body = document.createElement("div");
        body.className = "bd-notice__body";
        const text = document.createElement("p");
        text.className = "bd-landing__status";
        text.setAttribute("role", "status");
        text.textContent = "DUET を開いています…";
        body.appendChild(text);
        status.appendChild(body);
        panel.appendChild(status);

        const brand = document.createElement("p");
        brand.className = "bd-landing__brand";
        brand.textContent = "BetterDuet";
        panel.appendChild(brand);

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
                // After a DUET logout the Shibboleth session is gone too (E-027). A fetch cannot follow the
                // cross-site SSO redirect, so let DUET's own entry page do the round trip once (GUARD-004).
                options.onNotice = (id) => {
                    if (id === "GUARD-4" && !session.get(KEY_SSO_TRIED)) {
                        session.set(KEY_SSO_TRIED, "1");
                        location.replace(C.SSO_RETRY_URL);
                        return;
                    }
                    showNotice(id);
                };
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
