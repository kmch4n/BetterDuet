// Settings popup (SET-001..003). Saves the switches to chrome.storage.local and nothing else:
// it never reloads DUET tabs or sends anything to DUET (SET-006).
(() => {
    "use strict";

    const C = globalThis.BetterDuetCore;
    const KEYS = Object.keys(C.DEFAULT_SETTINGS);
    const LAST_CATEGORY_KEY = "betterduet:popupCategory";

    // The stored switches, before Back is forced off by the protection switch.
    let stored = C.normalizeSettings(null);

    const input = (key) => document.getElementById(key);
    const tabs = () => Array.from(document.querySelectorAll('.category[role="tab"]'));
    const panels = () => Array.from(document.querySelectorAll('.panel[role="tabpanel"]'));

    async function load() {
        try {
            const result = await chrome.storage.local.get(C.SETTINGS_KEY);
            return C.normalizeSettings(result ? result[C.SETTINGS_KEY] : null);
        } catch (error) {
            return C.normalizeSettings(null);
        }
    }

    async function save(next) {
        try {
            await chrome.storage.local.set({ [C.SETTINGS_KEY]: next });
            return true;
        } catch (error) {
            return false;
        }
    }

    function showError(message) {
        const status = document.getElementById("status");
        status.textContent = message;
        clearTimeout(showError.timer);
        showError.timer = setTimeout(() => {
            status.textContent = "";
        }, 4000);
    }

    /** Shows the effective switches; Back is locked while protection is off (SET-003). */
    function render() {
        const effective = C.effectiveSettings(stored);
        for (const key of KEYS) {
            input(key).checked = effective[key];
        }
        const locked = !stored.protection;
        const back = input("back");
        if (locked) {
            back.setAttribute("aria-disabled", "true");
            back.setAttribute("aria-describedby", "back-lock");
        } else {
            back.removeAttribute("aria-disabled");
            back.removeAttribute("aria-describedby");
        }
        document.getElementById("back-lock").hidden = !locked;
        updateCounts();
    }

    function updateCounts() {
        for (const panel of panels()) {
            const switches = Array.from(panel.querySelectorAll(".switch"));
            const on = switches.filter((el) => el.checked).length;
            const count = document.querySelector(`[data-count-for="${panel.dataset.category}"]`);
            if (count) {
                count.textContent = `${on}/${switches.length}`;
                count.title = `${switches.length}項目中${on}項目がオン`;
            }
        }
    }

    function setupSwitches() {
        for (const key of KEYS) {
            const el = input(key);
            // A locked switch stays focusable so its reason can be read, but must not toggle.
            el.addEventListener("click", (event) => {
                if (el.getAttribute("aria-disabled") === "true") {
                    event.preventDefault();
                }
            });
            el.addEventListener("change", async () => {
                const previous = stored;
                stored = Object.assign({}, stored, { [key]: el.checked });
                el.removeAttribute("aria-invalid");
                render();
                if (!(await save(stored))) {
                    stored = previous;
                    render();
                    el.setAttribute("aria-invalid", "true");
                    showError("設定を保存できませんでした。もう一度切り替えてください");
                }
            });
        }
    }

    // ---- Categories (same keyboard model as BetterE-class) ----

    function selectCategory(category, focus) {
        let found = false;
        for (const tab of tabs()) {
            const selected = tab.dataset.category === category;
            found = found || selected;
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
            if (selected && focus) {
                tab.focus();
            }
        }
        if (!found) {
            selectCategory(tabs()[0].dataset.category, focus);
            return;
        }
        for (const panel of panels()) {
            panel.hidden = panel.dataset.category !== category;
        }
        try {
            localStorage.setItem(LAST_CATEGORY_KEY, category);
        } catch (error) {
            // Remembering the category is only a convenience.
        }
    }

    function setupCategories() {
        const list = tabs();
        list.forEach((tab, index) => {
            tab.addEventListener("click", () => selectCategory(tab.dataset.category, false));
            tab.addEventListener("keydown", (event) => {
                const moves = {
                    ArrowDown: (index + 1) % list.length,
                    ArrowUp: (index - 1 + list.length) % list.length,
                    Home: 0,
                    End: list.length - 1,
                };
                if (!(event.key in moves)) {
                    return;
                }
                event.preventDefault();
                selectCategory(list[moves[event.key]].dataset.category, true);
            });
        });
        let last = null;
        try {
            last = localStorage.getItem(LAST_CATEGORY_KEY);
        } catch (error) {
            // Fall back to the first category.
        }
        selectCategory(last || list[0].dataset.category, false);
    }

    document.addEventListener("DOMContentLoaded", async () => {
        document.getElementById("version").textContent = "v" + chrome.runtime.getManifest().version;
        setupCategories();
        setupSwitches();
        stored = await load();
        render();
    });
})();
