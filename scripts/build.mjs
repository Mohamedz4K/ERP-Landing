import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releases = JSON.parse(
  await fs.readFile(path.join(root, "releases.json"), "utf8"),
);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
for (const key of ["desktop", "mobile"]) {
  const release = releases[key];
  if (
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    !Number.isSafeInteger(release.bytes) ||
    release.bytes <= 0
  )
    throw Error(`Invalid ${key} metadata`);
  const url = new URL(release.url);
  if (
    url.origin !== "https://github.com" ||
    !url.pathname.startsWith("/Mohamedz4K/ERP-Landing/releases/download/") ||
    decodeURIComponent(url.pathname.split("/").at(-1)) !== release.filename
  )
    throw Error(`Unexpected ${key} download URL`);
  release.size = (release.bytes / 1_000_000).toFixed(1) + " MB";
}
const values = {
  ...releases,
  updatedLabel: new Intl.DateTimeFormat("ar-EG", {
    dateStyle: "long",
    timeZone: "Africa/Cairo",
  }).format(new Date(releases.updatedAt + "T12:00:00Z")),
  year: releases.updatedAt.slice(0, 4),
};
const template = await fs.readFile(path.join(root, "src/index.html"), "utf8");
const html = template.replace(/\{\{([\w.]+)\}\}/g, (_match, key) => {
  const value = key.split(".").reduce((item, part) => item?.[part], values);
  if (value == null || typeof value === "object")
    throw Error(`Unknown template field: ${key}`);
  return escape(value);
});
if (html.includes("{{")) throw Error("Unrendered template field");
const dist = path.join(root, "dist");
await fs.mkdir(dist, { recursive: true });
await fs.writeFile(path.join(root, "index.html"), html);
await fs.writeFile(path.join(dist, "index.html"), html);
for (const name of ["styles.css", "site.js", "assets"])
  await fs.cp(path.join(root, name), path.join(dist, name), {
    recursive: true,
  });
console.log(
  "Built static ERP-Landing: desktop " +
    releases.desktop.version +
    ", mobile " +
    releases.mobile.version +
    " / " +
    releases.mobile.build,
);
