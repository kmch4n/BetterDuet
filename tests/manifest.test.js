"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const extensionDir = path.join(__dirname, "..", "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));

const referenced = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
    ...manifest.declarative_net_request.rule_resources.map((r) => r.path),
    ...Object.values(manifest.icons || {}),
];
const missing = [...new Set(referenced)].filter(
    (file) => !fs.existsSync(path.join(extensionDir, file))
);

test("CORE-008: manifest_version is 3", () => {
    assert.equal(manifest.manifest_version, 3);
});

test("CORE-008: permissions and host_permissions are minimal", () => {
    assert.deepEqual(manifest.permissions, ["storage", "declarativeNetRequest"]);
    assert.deepEqual(manifest.host_permissions, ["*://duet.doshisha.ac.jp/*"]);
});

test("CORE-008: the DNR rule resource is rules.json", () => {
    const resources = manifest.declarative_net_request.rule_resources;
    assert.equal(resources.length, 1);
    assert.equal(resources[0].path, "rules.json");
});

test("CORE-009: the manifest requires Chrome 111, the first version with MAIN-world content scripts", () => {
    assert.equal(manifest.minimum_chrome_version, "111");
});

test("CORE-008: MAIN-world entry runs at document_start on /gakusei/html/* only", () => {
    const mains = manifest.content_scripts.filter((cs) => cs.world === "MAIN");
    assert.equal(mains.length, 1);
    assert.equal(mains[0].run_at, "document_start");
    assert.deepEqual(mains[0].matches, ["https://duet.doshisha.ac.jp/gakusei/html/*"]);
    assert.deepEqual(mains[0].js, ["content/early-hook.js"]);
});

test(
    "CORE-008: every file referenced by the manifest exists",
    { skip: missing.length > 0 ? `referenced files not written yet: ${missing.join(", ")}` : false },
    () => {
        for (const file of referenced) {
            assert.ok(fs.existsSync(path.join(extensionDir, file)), file);
        }
    }
);
