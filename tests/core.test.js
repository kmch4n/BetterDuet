const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extension/core.js");

const fakeForm = (id, action, inputs) => ({
    id,
    getAttribute: (name) => (name === "action" ? action : null),
    querySelectorAll: () => inputs,
});

const load = (record, screenId, pendingBack) =>
    core.applyLoad(record, { tabId: 1, screenId, pendingBack: pendingBack || null });

test("CORE-008 core is exposed on globalThis with frozen constants", () => {
    assert.equal(globalThis.BetterDuetCore, core);
    assert.ok(Object.isFrozen(core.MENU_SCREENS));
    assert.ok(Object.isFrozen(core.MENU_SCREENS[0]));
    assert.ok(Object.isFrozen(core.NOTICES));
    assert.ok(Object.isFrozen(core.NOTICES["TAB-1"]));
    assert.ok(Object.isFrozen(core.NOTICES["TAB-1"].button));
    assert.ok(Object.isFrozen(core.DUET_FORM_IDS));
    assert.ok(Object.isFrozen(core.COMMON_FORM_IDS));
});

test("CORE-001 MENU_SCREENS has 17 entries with derived actions", () => {
    assert.equal(core.MENU_SCREENS.length, 17);
    assert.deepEqual(core.menuEntry("FB02001G"), {
        screenId: "FB02001G",
        label: "ホーム",
        formId: "unloadform",
        action: "goHome",
    });
    const grades = core.menuEntry("FB20001G");
    assert.equal(grades.formId, "menuform");
    assert.equal(grades.action, "goFb20001g");
    assert.equal(core.menuEntry("FB17002G"), null);
});

test("CORE-001 screenIdFromAction handles paths, URLs, and suffixes", () => {
    assert.equal(core.screenIdFromAction("/gakusei/html/fb/fb020/FB02001G.html"), "FB02001G");
    assert.equal(core.screenIdFromAction("FB17001G.html?x=1"), "FB17001G");
    assert.equal(
        core.screenIdFromAction("https://duet.doshisha.ac.jp/a/FB17001G.html;jsessionid=abc"),
        "FB17001G"
    );
    assert.equal(core.screenIdFromAction("a/FB17001G.html#top"), "FB17001G");
    assert.equal(core.screenIdFromAction("/a/index.html"), null);
    assert.equal(core.screenIdFromAction(""), null);
    assert.equal(core.screenIdFromAction(null), null);
});

test("CORE-001 isMenuScreen distinguishes menu and detail screens", () => {
    assert.equal(core.isMenuScreen("FB17001G"), true);
    assert.equal(core.isMenuScreen("FB17002G"), false);
    assert.equal(core.isMenuScreen(undefined), false);
});

test("CORE-001 screenIdFromActionName maps menu actions", () => {
    assert.equal(core.screenIdFromActionName("goFb17001g"), "FB17001G");
    assert.equal(core.screenIdFromActionName("goHome"), core.HOME);
    assert.equal(core.screenIdFromActionName("doDownload"), null);
    assert.equal(core.screenIdFromActionName("goFb1700g"), null);
    assert.equal(core.screenIdFromActionName(""), null);
});

test("GUARD-003 classifyErrorText recognizes both error phrases", () => {
    assert.equal(core.classifyErrorText("ページ間の移動でエラーが発生しました"), "transition");
    assert.equal(core.classifyErrorText("<p>認証エラー</p>"), "auth");
    assert.equal(core.classifyErrorText("通常の画面"), null);
    assert.equal(core.classifyErrorText(null), null);
});

test("CORE-004 templateFromForm collects hidden fields and blanks the link field", () => {
    const form = fakeForm("menuform", "/x/FB02001G.html", [
        { name: "menuform:__link_clicked__", value: "menuform:old" },
        { name: "menuform/_view", value: "abc" },
        { name: "", value: "skipped" },
        { value: "nameless" },
    ]);
    assert.deepEqual(core.templateFromForm(form), {
        formId: "menuform",
        action: "/x/FB02001G.html",
        fields: [
            ["menuform:__link_clicked__", ""],
            ["menuform/_view", "abc"],
        ],
    });
});

test("CORE-004 templateFromForm adds the link field when missing", () => {
    const form = fakeForm("form1", "a.html", [{ name: "form1/k", value: "v" }]);
    assert.deepEqual(core.templateFromForm(form).fields, [
        ["form1/k", "v"],
        ["form1:__link_clicked__", ""],
    ]);
});

test("CORE-004 isViewKeyedName, form id predicates, and download detection", () => {
    assert.equal(core.isViewKeyedName("menuform/abc", "menuform"), true);
    assert.equal(core.isViewKeyedName("menuform:abc", "menuform"), false);
    assert.equal(core.isViewKeyedName("form1/x", "menuform"), false);
    assert.equal(core.isCommonForm("member"), true);
    assert.equal(core.isCommonForm("form1"), false);
    assert.equal(core.isDuetForm("form1"), true);
    assert.equal(core.isDuetForm("other"), false);
    assert.equal(core.isDownloadAction("doDownload"), true);
    assert.equal(core.isDownloadAction("DOWNLOADpdf"), true);
    assert.equal(core.isDownloadAction("goHome"), false);
});

test("GUARD-003 buildOpenPlan builds a plan from a menu entry", () => {
    const forms = {
        menuform: {
            formId: "menuform",
            action: "/a/FB17001G.html",
            fields: [
                ["menuform:__link_clicked__", ""],
                ["menuform/v", "1"],
            ],
        },
    };
    const plan = core.buildOpenPlan("FB17001G", forms);
    assert.equal(plan.action, "/a/FB17001G.html");
    assert.deepEqual(plan.fields, [
        ["menuform:__link_clicked__", "menuform:goFb17001g"],
        ["menuform/v", "1"],
    ]);
    assert.equal(forms.menuform.fields[0][1], "", "template must not be mutated");
});

test("GUARD-003 buildOpenPlan falls back to home and handles missing templates", () => {
    const forms = {
        unloadform: {
            formId: "unloadform",
            action: "h.html",
            fields: [["unloadform:__link_clicked__", ""]],
        },
    };
    assert.deepEqual(core.buildOpenPlan("FB17002G", forms), {
        action: "h.html",
        fields: [["unloadform:__link_clicked__", "unloadform:goHome"]],
    });
    assert.equal(core.buildOpenPlan("FB17001G", forms), null);
    assert.equal(core.buildOpenPlan("FB02001G", {}), null);
});

test("TAB-003 rewriteTemplateFor returns action and view-keyed name", () => {
    const tpl = {
        formId: "menuform",
        action: "/a/new.html",
        fields: [
            ["menuform:__link_clicked__", ""],
            ["menuform/new", "x"],
        ],
    };
    assert.deepEqual(core.rewriteTemplateFor("menuform", tpl), {
        action: "/a/new.html",
        viewKeyedName: "menuform/new",
    });
});

test("TAB-003 rewriteTemplateFor throws on mismatch or missing field", () => {
    const tpl = { formId: "menuform", action: "a", fields: [["menuform:__link_clicked__", ""]] };
    assert.throws(() => core.rewriteTemplateFor("unloadform", tpl), /does not match/);
    assert.throws(() => core.rewriteTemplateFor("menuform", tpl), /view-keyed/);
    assert.throws(() => core.rewriteTemplateFor("menuform", null), Error);
});

test("TAB-002 decideSubmit returns send for the latest generation", () => {
    assert.equal(core.decideSubmit({ pageGen: 3, latestGen: 3, loggedOut: false, formId: "form1" }), "send");
});

test("TAB-003 decideSubmit rewrites stale common forms", () => {
    assert.equal(
        core.decideSubmit({ pageGen: 2, latestGen: 3, loggedOut: false, formId: "menuform" }),
        "rewrite"
    );
});

test("TAB-002 decideSubmit blocks stale screen-specific forms", () => {
    assert.equal(core.decideSubmit({ pageGen: 2, latestGen: 3, loggedOut: false, formId: "form1" }), "block");
});

test("TAB-005 decideSubmit reports loggedOut before anything else", () => {
    assert.equal(
        core.decideSubmit({ pageGen: 3, latestGen: 3, loggedOut: true, formId: "menuform" }),
        "loggedOut"
    );
});

test("BACK-002 applyLoad creates a record from null", () => {
    assert.deepEqual(load(null, "FB02001G"), {
        tabId: 1,
        screenId: "FB02001G",
        menuScreenId: "FB02001G",
        history: [{ s: "FB02001G", m: "FB02001G" }],
        index: 0,
    });
});

test("BACK-002 applyLoad keeps the previous menu screen for detail screens", () => {
    const r2 = load(load(null, "FB17001G"), "FB17002G");
    assert.equal(r2.menuScreenId, "FB17001G");
    assert.deepEqual(r2.history, [
        { s: "FB17001G", m: "FB17001G" },
        { s: "FB17002G", m: "FB17001G" },
    ]);
    assert.equal(r2.index, 1);
    assert.equal(load(null, "FB17002G").menuScreenId, core.HOME);
});

test("BACK-002 applyLoad does not duplicate a reloaded screen", () => {
    const r2 = load(load(null, "FB17001G"), "FB17001G");
    assert.equal(r2.history.length, 1);
    assert.equal(r2.index, 0);
});

test("BACK-002 applyLoad truncates forward history on a new navigation", () => {
    let r = load(null, "FB02001G");
    r = load(r, "FB20001G");
    r = load(r, "FB01701G");
    r = { ...r, index: 1 };
    r = load(r, "FB17001G");
    assert.deepEqual(
        r.history.map((e) => e.s),
        ["FB02001G", "FB20001G", "FB17001G"]
    );
    assert.equal(r.index, 2);
});

test("BACK-002 applyLoad with pendingBack keeps history and moves the index", () => {
    let r = load(null, "FB02001G");
    r = load(r, "FB20001G");
    r = load(r, "FB01701G");
    const back = load(r, "FB20001G", { nextIndex: 1, target: "FB20001G" });
    assert.equal(back.history.length, 3);
    assert.equal(back.index, 1);
    assert.deepEqual(back.history[1], { s: "FB20001G", m: "FB20001G" });
    assert.equal(back.screenId, "FB20001G");
});

test("BACK-002 applyLoad ignores pendingBack whose target does not match", () => {
    let r = load(null, "FB02001G");
    r = load(r, "FB20001G");
    const out = load(r, "FB01701G", { nextIndex: 0, target: "FB20001G" });
    assert.equal(out.history.length, 3);
    assert.equal(out.index, 2);
});

test("BACK-002 applyLoad caps history at 50 entries", () => {
    let r = null;
    for (let i = 0; i < 60; i++) {
        r = load(r, i % 2 === 0 ? "FB17001G" : "FB11001G");
    }
    assert.equal(r.history.length, 50);
    assert.equal(r.index, 49);
    assert.equal(r.history[49].s, r.screenId);
});

test("BACK-002 applyLoad always sets tabId and does not mutate input", () => {
    const r1 = load(null, "FB02001G");
    const snapshot = JSON.stringify(r1);
    const r2 = core.applyLoad(r1, { tabId: 99, screenId: "FB20001G", pendingBack: null });
    assert.equal(r2.tabId, 99);
    assert.equal(JSON.stringify(r1), snapshot);
});

test("BACK-002 planBack goes home -> grades -> notices, back twice", () => {
    let r = load(null, "FB02001G");
    r = load(r, "FB20001G");
    r = load(r, "FB01701G");
    const first = core.planBack(r);
    assert.deepEqual(first, { targetScreenId: "FB20001G", nextIndex: 1 });
    r = load(r, "FB20001G", { nextIndex: first.nextIndex, target: first.targetScreenId });
    assert.deepEqual(core.planBack(r), { targetScreenId: "FB02001G", nextIndex: 0 });
});

test("BACK-002 planBack returns the list screen from a detail screen", () => {
    const r = load(load(null, "FB17001G"), "FB17002G");
    assert.deepEqual(core.planBack(r), { targetScreenId: "FB17001G", nextIndex: 0 });
});

test("BACK-001 planBack returns null for a single entry", () => {
    assert.equal(core.planBack(load(null, "FB02001G")), null);
});

test("BACK-001 planBack returns null when only the same menu screen precedes", () => {
    const r = load(null, "FB17002G");
    r.history = [{ s: "FB17002G", m: core.HOME }];
    assert.equal(core.planBack(r), null);
});

test("BACK-001 planBack returns null for a missing record", () => {
    assert.equal(core.planBack(null), null);
});

test("GUARD-002 landingTarget returns entry for the entry path", () => {
    assert.deepEqual(
        core.landingTarget({ from: core.ENTRY_FROM, record: null, ownTabId: 1, loggedOut: true }),
        { kind: "entry" }
    );
});

test("TAB-005 landingTarget returns loggedOut", () => {
    assert.deepEqual(
        core.landingTarget({ from: "fb/fb020/FB02001G.html", record: null, ownTabId: 1, loggedOut: true }),
        { kind: "loggedOut" }
    );
});

test("GUARD-002 landingTarget returns the record's menu screen", () => {
    const record = { tabId: 1, screenId: "FB17002G", menuScreenId: "FB17001G", history: [], index: 0 };
    assert.deepEqual(core.landingTarget({ from: "x", record, ownTabId: 1, loggedOut: false }), {
        kind: "screen",
        screenId: "FB17001G",
        duplicated: false,
        hadDetail: true,
    });
    const dup = core.landingTarget({
        from: "x",
        record: { ...record, screenId: "FB17001G" },
        ownTabId: 2,
        loggedOut: false,
    });
    assert.equal(dup.duplicated, true);
    assert.equal(dup.hadDetail, false);
});

test("GUARD-002 landingTarget defaults to home without a record", () => {
    assert.deepEqual(core.landingTarget({ from: "x", record: null, ownTabId: 1, loggedOut: false }), {
        kind: "screen",
        screenId: core.HOME,
        duplicated: false,
        hadDetail: false,
    });
});

test("CORE-006 isLogoutBody matches raw and encoded bodies", () => {
    assert.equal(core.isLogoutBody("a=1&unloadform:__link_clicked__=unloadform:closeWindow&b=2"), true);
    assert.equal(core.isLogoutBody("unloadform%3A__link_clicked__=unloadform%3AcloseWindow"), true);
    assert.equal(core.isLogoutBody("unloadform:__link_clicked__=unloadform:goHome"), false);
    assert.equal(core.isLogoutBody(null), false);
    assert.equal(core.isLogoutBody({}), false);
});

test("GUARD-003 classifyEntryHtml distinguishes entry, error, and unknown", () => {
    const entry = "<form id=\"form1\"><a id=\"goHome\" onclick=\"submit('form1:goHome')\">x</a></form>";
    assert.equal(core.classifyEntryHtml(entry), "entry");
    assert.equal(core.classifyEntryHtml("<p>ページ間の移動でエラーが発生しました</p>"), "duetError");
    assert.equal(core.classifyEntryHtml("<p>認証エラー</p>"), "duetError");
    assert.equal(core.classifyEntryHtml("<html></html>"), "unknown");
    assert.equal(core.classifyEntryHtml(undefined), "unknown");
});

test("NOTICE-001 NOTICES has verbatim texts, kinds, and buttons", () => {
    assert.deepEqual(Object.keys(core.NOTICES), [
        "TAB-1",
        "TAB-2",
        "GUARD-1",
        "GUARD-2",
        "GUARD-3",
        "GUARD-4",
        "BACK-1",
    ]);
    assert.equal(core.NOTICES["BACK-1"].text, "これより前の画面はありません。");
    assert.equal(core.NOTICES["BACK-1"].button, null);
    assert.equal(core.NOTICES["BACK-1"].kind, "info");
    assert.deepEqual(core.NOTICES["TAB-1"].button, { label: "この画面を開き直す", action: "reopen" });
    assert.deepEqual(core.NOTICES["TAB-2"].button, { label: "SSO ポータルを開く", action: "openPortal" });
    assert.equal(core.NOTICES["GUARD-2"].kind, "info");
    assert.equal(core.NOTICES["GUARD-4"].kind, "warning");
});

test("CORE-008 timeouts and paths match the plan", () => {
    assert.equal(core.NAV_TIMEOUT_MS, 30000);
    assert.equal(core.ACK_TIMEOUT_MS, 1500);
    assert.equal(core.ENTRY_PATH, "/gakusei/html/" + core.ENTRY_FROM);
    assert.equal(core.screenIdFromAction(core.ENTRY_PATH), core.ENTRY_SCREEN);
});
