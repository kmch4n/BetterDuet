// ISOLATED world, /gakusei/html/* (LINK-001/002, SET-005).
// Turns DUET's `openUrl` popup links into plain links that open in a new tab. Nothing is sent to DUET.
(() => {
    "use strict";

    const C = globalThis.BetterDuetCore;
    const MARK = "data-bd-link";

    /** Reads the URL from where the onclick says DUET keeps it. */
    function resolve(source) {
        if (source.kind === "id") {
            const element = document.getElementById(source.key);
            return element && typeof element.value === "string" ? element.value : null;
        }
        if (source.kind === "class") {
            const element = document.getElementsByClassName(source.key)[0];
            return element ? element.textContent : null;
        }
        return source.key;
    }

    function rewriteLinks() {
        for (const anchor of document.querySelectorAll("a[onclick]")) {
            if (anchor.hasAttribute(MARK)) {
                continue;
            }
            const source = C.openUrlSource(anchor.getAttribute("onclick"));
            if (!source) {
                continue;
            }
            const href = C.externalLinkHref(resolve(source));
            if (!href) {
                // P-5: leave DUET's own popup in place.
                continue;
            }
            anchor.setAttribute("href", href);
            anchor.setAttribute("target", "_blank");
            anchor.setAttribute("rel", "noopener noreferrer");
            anchor.removeAttribute("onclick");
            anchor.setAttribute(MARK, "1");
        }
    }

    // Removing the onclick attribute from this isolated world does not drop the handler DUET's page
    // already compiled, so stop the click before it reaches the link. The default action (open href
    // in a new tab) is left alone.
    window.addEventListener(
        "click",
        (event) => {
            const target = event.target;
            if (target && typeof target.closest === "function" && target.closest("a[" + MARK + "]")) {
                event.stopPropagation();
            }
        },
        true,
    );

    const alive = typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
    C.readSettings(alive ? chrome.storage.local : null).then((settings) => {
        // SET-005: with the switch off, DUET keeps its own popup.
        if (!settings.links) {
            return;
        }
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", rewriteLinks, { once: true });
        } else {
            rewriteLinks();
        }
    });
})();
