// Relays probe commands from the page to the background service worker.
// Page usage: window.postMessage({ __probe: "req", id, cmd, args }, "*")
(() => {
    window.addEventListener("message", (e) => {
        if (e.source !== window || e.data?.__probe !== "req") return;
        const { id, cmd, args } = e.data;
        chrome.runtime.sendMessage({ cmd, args }, (res) => {
            window.postMessage({ __probe: "res", id, res: res ?? { error: chrome.runtime.lastError?.message } }, "*");
        });
    });
    document.documentElement.dataset.bdProbe = "1";
})();
