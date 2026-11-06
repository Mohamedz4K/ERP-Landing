import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = await fs.readFile(path.join(root, "dist/index.html"), "utf8");
const releases = JSON.parse(
  await fs.readFile(path.join(root, "releases.json"), "utf8"),
);
assert.match(html, /<html lang="ar" dir="rtl">/);
assert.equal((html.match(/<h1\b/g) || []).length, 1);
assert(!html.includes("{{"), "Unresolved release metadata");
for (const platform of ["desktop", "mobile"]) {
  const release = releases[platform];
  const anchor = html.match(new RegExp(`<a\\b[^>]*id="${platform}-download"[^>]*>`))?.[0];
  assert(anchor?.includes(`href="${release.url}"`), `${platform} download URL drift`);
  assert(html.includes(release.sha256), `${platform} checksum drift`);
  assert(html.includes(release.version), `${platform} version missing`);
}
assert(html.includes("بناء " + releases.mobile.build), "Mobile build missing");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const paths = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)]
  .map((m) => m[1])
  .filter((p) => !/^https?:/.test(p));
for (const file of paths)
  await fs.access(path.join(root, "dist", file.split("#")[0]));
for (const match of html.matchAll(/href="#([^"]+)"/g))
  assert(ids.has(match[1]), "Broken anchor " + match[1]);
for (const match of html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g))
  assert(match[0].includes("noopener"), "Unsafe external link");
assert(
  !html.includes("الإصدار v3.0.16") &&
    !html.includes("دقيقتين") &&
    !html.includes("اشتراكات مخفية"),
  "Stale or unverified marketing claim",
);
assert(!/https:\/\/fonts\./.test(html), "Font should be self-hosted");
console.log(
  "Passed: release/version/checksum parity, RTL/headings, local assets, anchors and external link safety.",
);
