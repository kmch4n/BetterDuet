// ISOLATED world. Notice bar renderer (NOTICE-001). Exposes globalThis.BetterDuetNotice.
(() => {
    "use strict";

    const C = globalThis.BetterDuetCore;
    const NOTICE_ID = "betterduet-notice";
    const TITLE = "BetterDuet からのお知らせ";

    function dismiss() {
        const existing = document.getElementById(NOTICE_ID);
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }
    }

    function runAction(action, options, button) {
        let handler = null;
        if (action === "reopen") {
            handler = options.onReopen;
        } else if (action === "openPortal") {
            handler =
                options.onOpenPortal ||
                (() => {
                    window.open(C.SSO_PORTAL_URL, "_blank", "noopener");
                });
        }
        if (typeof handler !== "function") {
            return;
        }
        // Block repeated clicks while the action runs; a navigation normally replaces the page.
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        Promise.resolve()
            .then(handler)
            .catch(() => {})
            .then(() => {
                button.disabled = false;
                button.removeAttribute("aria-busy");
            });
    }

    /**
     * @param {string} id notice ID from BetterDuetCore.NOTICES
     * @param {{ onReopen?: Function, onOpenPortal?: Function, container?: Element }} [options]
     * @returns {Element|null}
     */
    function show(id, options) {
        const opts = options || {};
        const definition = C.NOTICES[id];
        if (!definition) {
            return null;
        }
        const container = opts.container || document.getElementById("contents") || document.body;
        if (!container) {
            return null;
        }
        dismiss();

        // Same shape as DUET's own .block > h3 + .content > p.messageBox (NOTICE-002).
        const root = document.createElement("div");
        root.id = NOTICE_ID;
        root.className = "bd-scope bd-notice";
        root.setAttribute("data-kind", definition.kind);
        root.setAttribute("role", definition.kind === "warning" ? "alert" : "status");
        root.setAttribute("data-notice-id", id);

        const head = document.createElement("div");
        head.className = "bd-notice__head";
        const title = document.createElement("p");
        title.className = "bd-notice__title";
        title.textContent = TITLE;
        head.appendChild(title);

        const close = document.createElement("button");
        close.type = "button";
        close.className = "bd-notice__close";
        close.setAttribute("aria-label", "閉じる");
        close.textContent = "×";
        close.addEventListener("click", dismiss);
        head.appendChild(close);
        root.appendChild(head);

        const body = document.createElement("div");
        body.className = "bd-notice__body";
        const message = document.createElement("div");
        message.className = "bd-notice__message";
        const text = document.createElement("p");
        text.className = "bd-notice__text";
        if (definition.kind === "warning") {
            const badge = document.createElement("span");
            badge.className = "bd-badge";
            badge.textContent = "注意";
            text.appendChild(badge);
        }
        text.appendChild(document.createTextNode(definition.text));
        message.appendChild(text);

        if (definition.button) {
            const action = document.createElement("button");
            action.type = "button";
            action.className = "bd-button";
            action.textContent = definition.button.label;
            action.addEventListener("click", () => runAction(definition.button.action, opts, action));
            message.appendChild(action);
        }
        body.appendChild(message);
        root.appendChild(body);

        container.insertBefore(root, container.firstChild);
        return root;
    }

    globalThis.BetterDuetNotice = { show, dismiss };
})();
