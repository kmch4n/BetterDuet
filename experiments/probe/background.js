// BetterDuet Probe: records how the browser talks to DUET and lets us toggle
// experimental request gates. Never logs query strings, bodies, or cookie values.

const LOG_LIMIT = 500;
const HOSTS = ["duet.doshisha.ac.jp", "doshisha.ex-tic.com"];
const URL_FILTER = { urls: HOSTS.map((h) => `*://${h}/*`) };
const GATE_RULE_ID = 1;
const ALLOW_RULE_ID = 2;

let log = [];

function strip(url) {
    try {
        const u = new URL(url);
        return u.host + u.pathname + (u.search ? "?<q>" : "");
    } catch {
        return String(url);
    }
}

function push(entry) {
    log.push({ t: new Date().toISOString().slice(11, 23), ...entry });
    if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT);
}

chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
        push({ ev: "req", tab: d.tabId, type: d.type, method: d.method, url: strip(d.url), initiator: d.initiator || null });
    },
    URL_FILTER
);

chrome.webRequest.onBeforeRedirect.addListener(
    (d) => {
        push({ ev: "redirect", tab: d.tabId, type: d.type, status: d.statusCode, from: strip(d.url), to: strip(d.redirectUrl) });
    },
    URL_FILTER
);

chrome.webRequest.onCompleted.addListener(
    (d) => {
        if (d.type !== "main_frame" && d.type !== "xmlhttprequest") return;
        push({ ev: "done", tab: d.tabId, type: d.type, method: d.method, status: d.statusCode, url: strip(d.url) });
    },
    URL_FILTER
);

chrome.webRequest.onErrorOccurred.addListener(
    (d) => {
        push({ ev: "error", tab: d.tabId, type: d.type, method: d.method, error: d.error, url: strip(d.url) });
    },
    URL_FILTER
);

chrome.tabs.onCreated.addListener((t) => push({ ev: "tab-created", tab: t.id, openerTabId: t.openerTabId ?? null }));

chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0) return;
    if (!HOSTS.some((h) => d.url.includes(h)) && !d.url.startsWith("chrome-extension:")) return;
    push({ ev: "commit", tab: d.tabId, transition: d.transitionType, qualifiers: d.transitionQualifiers, url: strip(d.url) });
});

chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
    push({ ev: "dnr-match", tab: info.request.tabId, rule: info.rule.ruleId, method: info.request.method, type: info.request.type, url: strip(info.request.url) });
});

// Gate experiment: block top-level navigations to DUET pages unless the tab is
// explicitly allowed. Blocked navigations are redirected to `redirectPath` on the
// DUET origin so a content script can recover the tab without a cross-site POST.
async function setGate({ enabled, methods = ["get"], redirectPath = null }) {
    const removeRuleIds = [GATE_RULE_ID, ALLOW_RULE_ID];
    const addRules = [];
    if (enabled) {
        addRules.push({
            id: GATE_RULE_ID,
            priority: 1,
            action: redirectPath ? { type: "redirect", redirect: { url: `https://duet.doshisha.ac.jp${redirectPath}` } } : { type: "block" },
            condition: {
                regexFilter: "^https://duet\\.doshisha\\.ac\\.jp/gakusei/html/",
                resourceTypes: ["main_frame"],
                requestMethods: methods,
            },
        });
    }
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
    return chrome.declarativeNetRequest.getSessionRules();
}

async function allowTab({ tabId, allowed }) {
    const addRules = allowed
        ? [
              {
                  id: ALLOW_RULE_ID,
                  priority: 2,
                  action: { type: "allow" },
                  condition: { regexFilter: "^https://duet\\.doshisha\\.ac\\.jp/gakusei/html/", resourceTypes: ["main_frame"], tabIds: [tabId] },
              },
          ]
        : [];
    const started = performance.now();
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ALLOW_RULE_ID], addRules });
    return { ms: Math.round(performance.now() - started) };
}

async function cookieInfo() {
    const all = [];
    for (const h of HOSTS) {
        const cs = await chrome.cookies.getAll({ domain: h });
        for (const c of cs) {
            all.push({
                name: c.name,
                domain: c.domain,
                path: c.path,
                httpOnly: c.httpOnly,
                secure: c.secure,
                sameSite: c.sameSite,
                session: c.session,
                expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : null,
                valueLength: c.value.length,
            });
        }
    }
    return all;
}

const handlers = {
    ping: async (_, sender) => ({ ok: true, tabId: sender.tab?.id }),
    getLog: async ({ since = 0 } = {}) => log.slice(since),
    clearLog: async () => {
        log = [];
        return true;
    },
    cookies: cookieInfo,
    setGate,
    allowTab: async (args, sender) => allowTab({ tabId: args.tabId ?? sender.tab?.id, allowed: args.allowed }),
    rules: async () => chrome.declarativeNetRequest.getSessionRules(),
    tabs: async () => (await chrome.tabs.query({})).filter((t) => HOSTS.some((h) => (t.url || "").includes(h))).map((t) => ({ id: t.id, url: strip(t.url), discarded: t.discarded, active: t.active, openerTabId: t.openerTabId ?? null })),
    getTab: async ({ tabId }) => {
        const t = await chrome.tabs.get(tabId);
        return { id: t.id, openerTabId: t.openerTabId ?? null, url: strip(t.url) };
    },
    discard: async ({ tabId }) => {
        const t = await chrome.tabs.discard(tabId);
        return { id: t?.id, discarded: t?.discarded };
    },
    reload: async ({ tabId }) => {
        await chrome.tabs.reload(tabId);
        return true;
    },
    duplicate: async ({ tabId }) => {
        const t = await chrome.tabs.duplicate(tabId);
        return { id: t?.id, openerTabId: t?.openerTabId ?? null };
    },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const fn = handlers[msg?.cmd];
    if (!fn) {
        sendResponse({ error: `unknown cmd ${msg?.cmd}` });
        return false;
    }
    fn(msg.args || {}, sender)
        .then((result) => sendResponse({ result }))
        .catch((e) => sendResponse({ error: String(e) }));
    return true;
});
