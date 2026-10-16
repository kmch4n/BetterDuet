// Runs in the page's main world before DUET's own scripts. Records popstate
// listeners and history calls so we can confirm we can take over the back button.
// Set localStorage "bdProbeSuppressPopstate" to "1" to keep DUET's popstate
// listeners from being registered.
(() => {
    const events = (window.__bdProbeEvents = []);
    const note = (ev, extra) => events.push({ t: Date.now(), ev, ...extra });

    let suppress = false;
    try {
        suppress = localStorage.getItem("bdProbeSuppressPopstate") === "1";
    } catch {}

    const origAdd = window.addEventListener;
    window.addEventListener = function (type, listener, options) {
        if (type === "popstate") {
            note("popstate-listener", { suppressed: suppress });
            if (suppress) return;
        }
        return origAdd.call(this, type, listener, options);
    };

    const origPush = history.pushState;
    history.pushState = function (...args) {
        note("pushState", { len: history.length });
        return origPush.apply(this, args);
    };

    origAdd.call(window, "popstate", () => note("popstate", { len: history.length }));
    origAdd.call(window, "pageshow", (e) => note("pageshow", { persisted: e.persisted }));
    note("init", { suppress, nav: performance.getEntriesByType("navigation")[0]?.type });
})();
