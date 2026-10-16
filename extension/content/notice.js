// ISOLATED world. Notice bar renderer (NOTICE-001). Exposes globalThis.BetterDuetNotice.
(() => {
    "use strict";

    const C = globalThis.BetterDuetCore;
    const NOTICE_ID = "betterduet-notice";

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
        Promise.resolve()
            .then(handler)
            .catch(() => {})
            .then(() => {
                button.disabled = false;
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

        const root = document.createElement("div");
        root.id = NOTICE_ID;
        root.className = "betterduet-notice betterduet-notice--" + definition.kind;
        root.setAttribute("role", definition.kind === "warning" ? "alert" : "status");
        root.setAttribute("data-notice-id", id);

        const text = document.createElement("p");
        text.className = "betterduet-notice__text";
        text.textContent = definition.text;
        root.appendChild(text);

        if (definition.button) {
            const action = document.createElement("button");
            action.type = "button";
            action.className = "betterduet-notice__action";
            action.textContent = definition.button.label;
            action.addEventListener("click", () => runAction(definition.button.action, opts, action));
            root.appendChild(action);
        }

        const close = document.createElement("button");
        close.type = "button";
        close.className = "betterduet-notice__close";
        close.setAttribute("aria-label", "閉じる");
        close.textContent = "×";
        close.addEventListener("click", dismiss);
        root.appendChild(close);

        container.insertBefore(root, container.firstChild);
        return root;
    }

    globalThis.BetterDuetNotice = { show, dismiss };
})();
