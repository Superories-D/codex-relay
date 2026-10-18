// Compare the packaged application to the exact local build; no user profile.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const root = path.resolve(__dirname, "../..");
const version = require(path.join(root, "package.json")).version;
const directory = path.join(root, "release", `desktop-${version}`);
const archive = path.join(directory, "win-unpacked/resources/app.asar");
const files = asar.listPackage(archive).map((file) => file.replaceAll("\\", "/"));
const bundled = files.filter((file) => /^\/dist\/.+\.(?:cjs|js|css)$/.test(file));
assert.ok(bundled.length >= 5);
for (const file of bundled) {
  assert.deepEqual(asar.extractFile(archive, path.normalize(file.slice(1))), fs.readFileSync(path.join(root, file.slice(1))), file);
}
assert.equal(JSON.parse(asar.extractFile(archive, "package.json").toString()).version, version);
assert.equal(files.some((file) => /^\/(?:qa-output|runtime|release|\.git)(?:\/|$)/.test(file)), false);
const report = { version, archiveEntries: files.length, bundles: bundled, archiveMatchesSource: true, privateDirectoriesExcluded: true };
fs.writeFileSync(path.join(root, "qa-output", `package-${version.replaceAll(".", "")}-integrity.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
