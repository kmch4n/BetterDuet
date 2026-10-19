/**
 * @typedef {{ formId: string, action: string, fields: Array<[string, string]> }} FormTemplate
 * @typedef {{ [formId: string]: FormTemplate }} FormMap
 * @typedef {{ action: string, fields: Array<[string, string]> }} Plan
 * @typedef {{ s: string, m: string }} HistoryEntry
 * @typedef {{ tabId: number, screenId: string, menuScreenId: string, history: HistoryEntry[], index: number }} TabRecord
 */

const BetterDuetCore = (() => {
    "use strict";

    const HOME = "FB02001G";
    const NOTICES_SCREEN = "FB01701G";

    const menu = (screenId, label) => {
        if (screenId === HOME) {
            return Object.freeze({ screenId, label, formId: "unloadform", action: "goHome" });
        }
        const digits = screenId.slice(2, 7);
        return Object.freeze({ screenId, label, formId: "menuform", action: "goFb" + digits + "g" });
    };

    const MENU_SCREENS = Object.freeze([
        menu("FB02001G", "ホーム"),
        menu("FB17001G", "登録科目一覧"),
        menu("FB11001G", "試験一覧"),
        menu("FB11501G", "レポート一覧"),
        menu("FB20001G", "成績確認"),
        menu("FB18001G", "副専攻一覧"),
        menu("FB18003G", "パッケージ一覧"),
        menu("FB18005G", "教育プログラム一覧"),
        menu("FB19003G", "免許資格一覧"),
        menu("FB03001G", "メッセージ一覧"),
        menu("FB21001G", "授業評価アンケート"),
        menu("FB12001G", "連絡先等確認・変更"),
        menu("FB30001G", "メール送信設定"),
        menu("FB01701G", "お知らせ"),
        menu("FB01501G", "マニュアル"),
        menu("FB01601G", "よくある質問"),
        menu("FB01801G", "推奨環境"),
    ]);

    const DUET_FORM_IDS = Object.freeze(["unloadform", "member", "form1", "menuform"]);
    const COMMON_FORM_IDS = Object.freeze(["unloadform", "member", "menuform"]);

    const ENTRY_PATH = "/gakusei/html/fb/fb010/FB01090G.html";
    const ENTRY_FROM = "fb/fb010/FB01090G.html";
    const ENTRY_SCREEN = "FB01090G";
    const LANDING_PATH = "/betterduet-landing";
    const SSO_PORTAL_URL = "https://doshisha.ex-tic.com/idm/user/portal/";
    // The DNR allow rule lets exactly this entry URL through so DUET can run its own SSO round trip (GUARD-004).
    const SSO_RETRY_URL = "https://duet.doshisha.ac.jp/gakusei/html/fb/fb010/FB01090G.html?betterduet=sso";

    const LOGOUT_PATTERN = /unloadform(?::|%3A)__link_clicked__=unloadform(?::|%3A)closeWindow/i;

    const notice = (kind, text, button) => Object.freeze({ kind, text, button: button ? Object.freeze(button) : null });
    const REOPEN = { label: "この画面を開き直す", action: "reopen" };
    const PORTAL = { label: "SSO ポータルを開く", action: "openPortal" };

    const NOTICES = Object.freeze({
        "TAB-1": notice(
            "warning",
            "別のタブで DUET を操作したため、このタブの画面は古くなっています。この操作を続けるには、画面を開き直してください。",
            REOPEN,
        ),
        "TAB-2": notice(
            "warning",
            "DUET からログアウトしています。続けるには、SSO ポータルから DUET を開き直してください。",
            PORTAL,
        ),
        "GUARD-1": notice("info", "再読み込みのため、一覧の画面を開き直しました。詳細の画面は開き直せません。", null),
        "GUARD-2": notice("info", "DUET のセッションが切れていたため、自動で入り直しました。", null),
        "GUARD-3": notice(
            "warning",
            "DUET を開き直せませんでした。SSO ポータルから DUET を開き直してください。",
            PORTAL,
        ),
        "GUARD-4": notice(
            "warning",
            "SSO のログインが切れています。SSO ポータルからログインし直してください。",
            PORTAL,
        ),
        "BACK-1": notice("info", "これより前の画面はありません。", null),
    });

    const NAV_TIMEOUT_MS = 30000;
    const DOWNLOAD_SETTLE_MS = 3000;
    const REVIVE_TIMEOUT_MS = 20000;
    const ACK_TIMEOUT_MS = 1500;
    const GEN_WAIT_MS = 5000;
    const KEEPALIVE_MS = 10000;

    const HISTORY_CAP = 50;

    // Feature switches (SET-002). Every switch is on unless the user turned it off.
    const SETTINGS_KEY = "betterduet:settings";
    const DEFAULT_SETTINGS = Object.freeze({ protection: true, back: true, links: true });
    const GUARD_RULESET_ID = "guard";

    /** @param {string} action @returns {string|null} */
    function screenIdFromAction(action) {
        if (typeof action !== "string") {
            return null;
        }
        const clean = action.split(/[?;#]/)[0];
        const base = clean.slice(clean.lastIndexOf("/") + 1).replace(/\.html$/, "");
        return /^FB\d{5}G$/.test(base) ? base : null;
    }

    /** @param {string} id */
    function menuEntry(id) {
        return MENU_SCREENS.find((entry) => entry.screenId === id) || null;
    }

    /** @param {string} id */
    function isMenuScreen(id) {
        return menuEntry(id) !== null;
    }

    /** @param {string} actionName @returns {string|null} */
    function screenIdFromActionName(actionName) {
        if (actionName === "goHome") {
            return HOME;
        }
        const match = /^goFb(\d{5})g$/.exec(String(actionName));
        return match ? "FB" + match[1] + "G" : null;
    }

    /** @param {string} text @returns {"transition"|"auth"|null} */
    function classifyErrorText(text) {
        const value = String(text == null ? "" : text);
        if (value.includes("ページ間の移動でエラーが発生しました")) {
            return "transition";
        }
        if (value.includes("認証エラー")) {
            return "auth";
        }
        return null;
    }

    /** @returns {FormTemplate} */
    function templateFromForm(form) {
        const formId = form.id;
        const linkName = formId + ":__link_clicked__";
        const fields = [];
        let hasLink = false;
        for (const input of form.querySelectorAll("input[type=hidden]")) {
            if (!input.name) {
                continue;
            }
            if (input.name === linkName) {
                hasLink = true;
                fields.push([input.name, ""]);
            } else {
                fields.push([input.name, input.value == null ? "" : String(input.value)]);
            }
        }
        if (!hasLink) {
            fields.push([linkName, ""]);
        }
        return { formId, action: form.getAttribute("action"), fields };
    }

    function isViewKeyedName(name, formId) {
        return String(name).startsWith(formId + "/");
    }

    function isCommonForm(id) {
        return COMMON_FORM_IDS.includes(id);
    }

    function isDuetForm(id) {
        return DUET_FORM_IDS.includes(id);
    }

    function isDownloadAction(name) {
        return /download/i.test(String(name));
    }

    /** @param {string} screenId @param {FormMap} forms @returns {Plan|null} */
    function buildOpenPlan(screenId, forms) {
        const entry = menuEntry(screenId) || menuEntry(HOME);
        const template = forms ? forms[entry.formId] : null;
        if (!template) {
            return null;
        }
        const linkName = entry.formId + ":__link_clicked__";
        const fields = template.fields.map(([name, value]) => [name, value]);
        const value = entry.formId + ":" + entry.action;
        const at = fields.findIndex(([name]) => name === linkName);
        if (at >= 0) {
            fields[at] = [linkName, value];
        } else {
            fields.push([linkName, value]);
        }
        return { action: template.action, fields };
    }

    /** @param {string} liveFormId @param {FormTemplate} latestTemplate */
    function rewriteTemplateFor(liveFormId, latestTemplate) {
        if (!latestTemplate || latestTemplate.formId !== liveFormId) {
            throw new Error("Template form id does not match the live form id: " + liveFormId);
        }
        const field = latestTemplate.fields.find(([name]) => isViewKeyedName(name, liveFormId));
        if (!field) {
            throw new Error("Template has no view-keyed field for form: " + liveFormId);
        }
        return { action: latestTemplate.action, viewKeyedName: field[0] };
    }

    function decideSubmit({ pageGen, latestGen, loggedOut, formId }) {
        if (loggedOut) {
            return "loggedOut";
        }
        if (pageGen === latestGen) {
            return "send";
        }
        return isCommonForm(formId) ? "rewrite" : "block";
    }

    /** @param {TabRecord|null} record @returns {TabRecord} */
    function applyLoad(record, { tabId, screenId, pendingBack }) {
        const prevMenu = record && record.menuScreenId ? record.menuScreenId : HOME;
        const menuScreenId = isMenuScreen(screenId) ? screenId : prevMenu;
        const entry = { s: screenId, m: menuScreenId };
        const hasHistory = record && Array.isArray(record.history) && record.history.length > 0;

        let history;
        let index;
        if (hasHistory && pendingBack && pendingBack.target === menuScreenId) {
            history = record.history.map((e) => ({ s: e.s, m: e.m }));
            index = pendingBack.nextIndex;
            history[index] = entry;
        } else if (hasHistory) {
            history = record.history.slice(0, record.index + 1).map((e) => ({ s: e.s, m: e.m }));
            const current = history[history.length - 1];
            if (!current || current.s !== screenId) {
                history.push(entry);
            }
            index = history.length - 1;
        } else {
            history = [entry];
            index = 0;
        }

        if (history.length > HISTORY_CAP) {
            const drop = history.length - HISTORY_CAP;
            history = history.slice(drop);
            index = Math.max(0, index - drop);
        }
        return { tabId, screenId, menuScreenId, history, index };
    }

    /** @param {TabRecord} record */
    function planBack(record) {
        if (!record || !Array.isArray(record.history)) {
            return null;
        }
        const cur = record.history[record.index];
        if (!cur) {
            return null;
        }
        for (let i = record.index - 1; i >= 0; i--) {
            if (record.history[i].m !== cur.s) {
                return { targetScreenId: record.history[i].m, nextIndex: i };
            }
        }
        return null;
    }

    function landingTarget({ from, record, ownTabId, loggedOut }) {
        if (from === ENTRY_FROM) {
            return { kind: "entry" };
        }
        if (loggedOut) {
            return { kind: "loggedOut" };
        }
        if (record) {
            return {
                kind: "screen",
                screenId: record.menuScreenId,
                duplicated: record.tabId !== ownTabId,
                hadDetail: !isMenuScreen(record.screenId),
            };
        }
        return { kind: "screen", screenId: HOME, duplicated: false, hadDetail: false };
    }

    function isLogoutBody(body) {
        return typeof body === "string" && LOGOUT_PATTERN.test(body);
    }

    // `return openUrl(<arg>)` and nothing else; <arg> is one of the shapes DUET uses (LINK-001, E-036).
    const OPEN_URL_PATTERN =
        /^\s*return\s+openUrl\(\s*(?:\$\(\s*'#([\w-]+)'\s*\)\.val\(\)|\$\(\s*'\.([\w-]+)'\s*\)\.html\(\)|'([^']*)'|"([^"]*)")\s*\)\s*;?\s*$/;

    /**
     * Tells where an `openUrl` link keeps its URL.
     * @param {string|null} onclick @returns {{ kind: "id"|"class"|"literal", key: string }|null}
     */
    function openUrlSource(onclick) {
        const match = OPEN_URL_PATTERN.exec(String(onclick == null ? "" : onclick));
        if (!match) {
            return null;
        }
        if (match[1]) {
            return { kind: "id", key: match[1] };
        }
        if (match[2]) {
            return { kind: "class", key: match[2] };
        }
        return { kind: "literal", key: match[3] !== undefined ? match[3] : match[4] };
    }

    /**
     * The href for a rewritten link, or null when DUET's own popup should stay (LINK-002).
     * Mirrors DUET's openUrl check (http:// or https:// only) and skips DUET's own host.
     * @param {string|null} raw @returns {string|null}
     */
    function externalLinkHref(raw) {
        const value = String(raw == null ? "" : raw).trim();
        if (!/^https?:\/\//.test(value)) {
            return null;
        }
        let url;
        try {
            url = new URL(value);
        } catch (e) {
            return null;
        }
        if (url.hostname.toLowerCase() === "duet.doshisha.ac.jp") {
            return null;
        }
        return value;
    }

    /**
     * Stored settings with every missing or non-boolean switch replaced by its default (SET-002).
     * @param {unknown} raw @returns {{ protection: boolean, back: boolean, links: boolean }}
     */
    function normalizeSettings(raw) {
        const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
        const settings = {};
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            settings[key] = typeof source[key] === "boolean" ? source[key] : DEFAULT_SETTINGS[key];
        }
        return settings;
    }

    /**
     * The switches that actually apply: Back needs the protection switch (SET-003).
     * @param {unknown} raw @returns {{ protection: boolean, back: boolean, links: boolean }}
     */
    function effectiveSettings(raw) {
        const settings = normalizeSettings(raw);
        settings.back = settings.protection && settings.back;
        return settings;
    }

    /**
     * Reads the effective settings from a chrome.storage area; defaults when it fails (SET-002).
     * @param {{ get: Function }|null|undefined} area
     */
    async function readSettings(area) {
        try {
            const result = await area.get(SETTINGS_KEY);
            return effectiveSettings(result ? result[SETTINGS_KEY] : null);
        } catch (e) {
            return effectiveSettings(null);
        }
    }

    /** @param {string} html @returns {"entry"|"duetError"|"unknown"} */
    function classifyEntryHtml(html) {
        const text = String(html == null ? "" : html);
        if (text.includes("form1") && text.includes("form1:goHome")) {
            return "entry";
        }
        if (classifyErrorText(text)) {
            return "duetError";
        }
        return "unknown";
    }

    return {
        MENU_SCREENS,
        HOME,
        NOTICES_SCREEN,
        DUET_FORM_IDS,
        COMMON_FORM_IDS,
        ENTRY_PATH,
        ENTRY_FROM,
        ENTRY_SCREEN,
        LANDING_PATH,
        SSO_PORTAL_URL,
        SSO_RETRY_URL,
        LOGOUT_PATTERN,
        NOTICES,
        NAV_TIMEOUT_MS,
        DOWNLOAD_SETTLE_MS,
        REVIVE_TIMEOUT_MS,
        ACK_TIMEOUT_MS,
        GEN_WAIT_MS,
        KEEPALIVE_MS,
        SETTINGS_KEY,
        DEFAULT_SETTINGS,
        GUARD_RULESET_ID,
        screenIdFromAction,
        isMenuScreen,
        menuEntry,
        screenIdFromActionName,
        classifyErrorText,
        templateFromForm,
        isViewKeyedName,
        isCommonForm,
        isDuetForm,
        isDownloadAction,
        buildOpenPlan,
        rewriteTemplateFor,
        decideSubmit,
        applyLoad,
        planBack,
        landingTarget,
        isLogoutBody,
        classifyEntryHtml,
        openUrlSource,
        externalLinkHref,
        normalizeSettings,
        effectiveSettings,
        readSettings,
    };
})();

globalThis.BetterDuetCore = BetterDuetCore;
if (typeof module !== "undefined" && module.exports) {
    module.exports = BetterDuetCore;
}
