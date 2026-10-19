"use strict";

// Runs extension/content/links.js in node:vm with a small fake DOM (LINK-001/002, SET-005).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT_DIR = path.join(__dirname, "..", "extension");
const CORE_SOURCE = fs.readFileSync(path.join(EXT_DIR, "core.js"), "utf8");
const LINKS_PATH = path.join(EXT_DIR, "content", "links.js");
const LINKS_SOURCE = fs.readFileSync(LINKS_PATH, "utf8");

const PANOPTO = "https://doshisha.ap.panopto.com/Panopto/Pages/Viewer.aspx?id=abc&x=1";
const MANUAL = "https://duet-man.doshisha.ac.jp/manual/guide.pdf";

function element(attrs, extra) {
    const map = new Map(Object.entries(attrs || {}));
    return Object.assign(
        {
            getAttribute: (name) => (map.has(name) ? map.get(name) : null),
            setAttribute: (name, value) => map.set(name, String(value)),
            removeAttribute: (name) => map.delete(name),
            hasAttribute: (name) => map.has(name),
            attrs: map,
        },
        extra,
    );
}

/** Lets the settings read and the rewrite that follows it finish. */
async function settle() {
    for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/** Builds a page with the given anchors and URL holders, runs links.js, and returns the anchors. */
async function run({ anchors, byId = {}, byClass = {}, settings }) {
    const document = {
        readyState: "complete",
        querySelectorAll: (selector) => {
            assert.equal(selector, "a[onclick]");
            return anchors.filter((a) => a.hasAttribute("onclick"));
        },
        getElementById: (id) => byId[id] || null,
        getElementsByClassName: (name) => (byClass[name] ? [byClass[name]] : []),
        addEventListener: () => assert.fail("readyState is complete"),
    };
    const clickListeners = [];
    const window = {
        addEventListener: (type, fn, capture) => {
            assert.equal(type, "click");
            assert.equal(capture, true);
            clickListeners.push(fn);
        },
    };
    const local = settings === undefined ? {} : { "betterduet:settings": settings };
    const chrome = { runtime: { id: "ext" }, storage: { local: { get: async (key) => ({ [key]: local[key] }) } } };
    const context = vm.createContext({ document, window, URL, chrome });
    vm.runInContext(CORE_SOURCE, context);
    vm.runInContext(LINKS_SOURCE, context, { filename: LINKS_PATH });
    await settle();
    /** Fires a capture-phase click on `target`; returns whether propagation was stopped. */
    const click = (target) => {
        let stopped = false;
        const event = {
            target,
            stopPropagation: () => (stopped = true),
            preventDefault: () => assert.fail("must not cancel"),
        };
        clickListeners.forEach((fn) => fn(event));
        return stopped;
    };
    const again = async () => {
        vm.runInContext(LINKS_SOURCE, context, { filename: LINKS_PATH });
        await settle();
    };
    return { anchors, click, again };
}

/** Adds closest() so the click guard can find the link from the clicked node. */
function withClosest(anchor) {
    anchor.closest = (selector) =>
        selector === "a[data-bd-link]" && anchor.hasAttribute("data-bd-link") ? anchor : null;
    return anchor;
}

const duetLink = (onclick) => element({ href: "?newwindow=true#", target: "_blank", onclick });

test("LINK-001: the reference-URL link becomes a plain new-tab link", async () => {
    const anchor = duetLink("return openUrl($('#sansyoUrlZ1').val());");
    await run({ anchors: [anchor], byId: { sansyoUrlZ1: { value: PANOPTO } } });
    assert.equal(anchor.getAttribute("href"), PANOPTO);
    assert.equal(anchor.getAttribute("target"), "_blank");
    assert.equal(anchor.getAttribute("rel"), "noopener noreferrer");
    assert.equal(anchor.hasAttribute("onclick"), false);
});

test("LINK-001: a manual link reads the URL from the hidden span's text", async () => {
    const anchor = duetLink("return openUrl($('.linkUrl0').html())");
    await run({ anchors: [anchor], byClass: { linkUrl0: { textContent: "  " + MANUAL + "\n" } } });
    assert.equal(anchor.getAttribute("href"), MANUAL);
    assert.equal(anchor.hasAttribute("onclick"), false);
});

test("LINK-001: a click on a rewritten link never reaches DUET's onclick, other clicks do", async () => {
    const rewritten = withClosest(duetLink("return openUrl($('#u').val());"));
    const untouched = withClosest(duetLink("return callSyllabusInfo('2026', '1');"));
    const page = await run({ anchors: [rewritten, untouched], byId: { u: { value: PANOPTO } } });
    assert.equal(page.click(rewritten), true);
    assert.equal(page.click(untouched), false);
    assert.equal(page.click({}), false);
});

test("LINK-001: running twice changes nothing more", async () => {
    const anchor = duetLink("return openUrl($('#u').val());");
    const page = await run({ anchors: [anchor], byId: { u: { value: PANOPTO } } });
    const before = new Map(anchor.attrs);
    await page.again();
    assert.deepEqual(anchor.attrs, before);
});

test("LINK-002: links that cannot be read or point at DUET keep DUET's popup", async () => {
    const missing = duetLink("return openUrl($('#nothere').val());");
    const relative = duetLink("return openUrl($('#rel').val());");
    const duet = duetLink("return openUrl('https://duet.doshisha.ac.jp/gakusei/html/fb/fb020/FB02001G.html');");
    const other = duetLink("return callSyllabusInfo('2026', '1');");
    await run({ anchors: [missing, relative, duet, other], byId: { rel: { value: "/x/y.pdf" } } });
    for (const anchor of [missing, relative, duet, other]) {
        assert.equal(anchor.getAttribute("href"), "?newwindow=true#");
        assert.equal(anchor.hasAttribute("onclick"), true);
        assert.equal(anchor.hasAttribute("rel"), false);
    }
});

test("SET-005: with the links switch off, links keep DUET's popup", async () => {
    const anchor = duetLink("return openUrl($('#u').val());");
    await run({ anchors: [anchor], byId: { u: { value: PANOPTO } }, settings: { links: false } });
    assert.equal(anchor.getAttribute("href"), "?newwindow=true#");
    assert.equal(anchor.hasAttribute("onclick"), true);
});

test("SET-005: the links switch works whatever the protection switch says", async () => {
    const anchor = duetLink("return openUrl($('#u').val());");
    await run({ anchors: [anchor], byId: { u: { value: PANOPTO } }, settings: { protection: false } });
    assert.equal(anchor.getAttribute("href"), PANOPTO);
});
