"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rules = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "extension", "rules.json"), "utf8")
);
const rule = rules[0];
const regex = new RegExp(rule.condition.regexFilter);

function substitute(url) {
    const match = regex.exec(url);
    if (!match) {
        return null;
    }
    return rule.action.redirect.regexSubstitution.replace("\\1", match[1]);
}

test("GUARD-001: rules.json contains one redirect rule and one SSO-retry allow rule", () => {
    assert.equal(rules.length, 2);
    assert.equal(rule.action.type, "redirect");
    assert.equal(rules.filter((r) => r.action.type === "redirect").length, 1);
    assert.equal(rules.filter((r) => r.action.type === "allow").length, 1);
});

test("GUARD-001: regexFilter matches /gakusei/html pages and the entry page", () => {
    assert.ok(regex.test("https://duet.doshisha.ac.jp/gakusei/html/fb/fb010/FB01002G.html"));
    assert.ok(regex.test("https://duet.doshisha.ac.jp/gakusei/html/fb/fb010/FB01090G.html"));
});

test("GUARD-001: regexFilter does not match other DUET paths or other hosts", () => {
    const urls = [
        "https://duet.doshisha.ac.jp/kokai/html/fi/fi020/FI02001G.html",
        "https://duet.doshisha.ac.jp/front/js/common.js",
        "https://duet.doshisha.ac.jp/betterduet-landing",
        "https://evil.example/gakusei/html/x",
    ];
    for (const url of urls) {
        assert.equal(regex.test(url), false, url);
    }
});

test("GUARD-001: substitution redirects to the landing page with the from parameter", () => {
    assert.equal(
        substitute("https://duet.doshisha.ac.jp/gakusei/html/fb/fb010/FB01002G.html"),
        "https://duet.doshisha.ac.jp/betterduet-landing?from=fb/fb010/FB01002G.html"
    );
});

test("GUARD-001: rule applies only to GET main_frame requests", () => {
    assert.deepEqual(rule.condition.requestMethods, ["get"]);
    assert.deepEqual(rule.condition.resourceTypes, ["main_frame"]);
});

test("GUARD-004 the SSO retry entry URL is allowed and nothing else is", () => {
    const allow = rules.find((rule) => rule.action.type === "allow");
    assert.ok(allow, "allow rule missing");
    assert.ok(allow.priority > rules.find((rule) => rule.action.type === "redirect").priority);
    assert.deepEqual(allow.condition.resourceTypes, ["main_frame"]);
    assert.deepEqual(allow.condition.requestMethods, ["get"]);
    const re = new RegExp(allow.condition.regexFilter);
    assert.ok(re.test(require("../extension/core.js").SSO_RETRY_URL));
    assert.ok(!re.test("https://duet.doshisha.ac.jp/gakusei/html/fb/fb010/FB01090G.html"));
    assert.ok(!re.test("https://duet.doshisha.ac.jp/gakusei/html/fb/fb010/FB01090G.html?betterduet=sso&x=1"));
    assert.ok(!re.test("https://duet.doshisha.ac.jp/gakusei/html/fb/fb010/FB01002G.html?betterduet=sso"));
});
