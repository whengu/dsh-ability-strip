// Verify a packed tarball against the working tree.
// Text files are compared with one trailing newline normalized away, because
// pnpm pack rewrites package.json without the final newline; everything else
// must match byte for byte.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const [tgzArg, dirArg] = process.argv.slice(2);
if (tgzArg === undefined) {
  console.error("usage: node scripts/verify-pack.mjs <tarball.tgz> [packageDir]");
  console.error("  Compares a packed tarball against the working tree and checks");
  console.error("  that every reference the manifest declares is inside the payload.");
  process.exit(2);
}
const tgz = path.resolve(tgzArg);
const pkgDir = dirArg === undefined
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  : path.resolve(dirArg);

if (!fs.existsSync(tgz)) {
  console.error(`verify-pack: tarball not found: ${tgz}`);
  process.exit(2);
}
const tar = zlib.gunzipSync(fs.readFileSync(tgz));
const NUL = "\u0000";
const field = (buf, s, l) => {
  const raw = buf.toString("utf8", s, s + l);
  const i = raw.indexOf(NUL);
  return (i === -1 ? raw : raw.slice(0, i)).trim();
};

const entries = [];
let off = 0;
while (off + 512 <= tar.length) {
  const name = field(tar, off, 100);
  if (name === "") break;
  const size = parseInt(field(tar, off + 124, 12), 8) || 0;
  const type = field(tar, off + 156, 1);
  const start = off + 512;
  if (type === "" || type === "0") {
    entries.push({ name, size, content: tar.subarray(start, start + size) });
  }
  off = start + Math.ceil(size / 512) * 512;
}

/** Compare readings with only the final newline treated as insignificant. */
const sameText = (a, b) => a.replace(/\n$/, "") === b.replace(/\n$/, "");

/** Deep structural equality that ignores object key order. */
function sameValues(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => sameValues(v, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => sameValues(a[k], b[k]));
  }
  return false;
}

let ok = true;
for (const e of entries) {
  const rel = e.name.replace(/^package\//, "");
  const disk = path.join(pkgDir, rel);
  if (!fs.existsSync(disk)) {
    console.log(`MISSING-ON-DISK  ${rel}`);
    ok = false;
    continue;
  }
  const packed = e.content.toString("utf8");
  const onDisk = fs.readFileSync(disk, "utf8");
  const exact = Buffer.compare(fs.readFileSync(disk), e.content) === 0;
  let equal = exact || sameText(packed, onDisk);
  let note = exact ? "exact" : equal ? "equal except trailing newline" : "CONTENT DIFFERS";

  // pnpm rewrites package.json: it strips the trailing newline and may reorder
  // keys, neither of which changes meaning. Compare that file by value.
  if (!equal && rel.endsWith("package.json")) {
    try {
      if (sameValues(JSON.parse(packed), JSON.parse(onDisk))) {
        equal = true;
        note = "equal by value (pnpm rewrote formatting)";
      }
    } catch {
      /* fall through to CONTENT DIFFERS */
    }
  }

  if (!equal) ok = false;
  console.log(`${equal ? "OK  " : "FAIL"}  ${rel}  (${e.size} bytes, ${note})`);
}

// Every declared export/reference must be present in the payload.
const pkgEntry = entries.find((e) => e.name === "package/package.json");
if (!pkgEntry) {
  console.log("FAIL  package/package.json absent from tarball");
  ok = false;
} else {
  const pkg = JSON.parse(pkgEntry.content.toString("utf8"));
  const declared = [
    pkg.main,
    ...Object.values(pkg.exports ?? {}),
    pkg.dsh?.bundle?.patch,
    ...(pkg.files ?? []),
  ].filter((v) => typeof v === "string");
  const present = new Set(entries.map((e) => e.name.replace(/^package\//, "")));
  console.log("--- declared references present in payload ---");
  for (const ref of new Set(declared)) {
    const rel = ref.replace(/^\.\//, "");
    const hit = present.has(rel);
    if (!hit) ok = false;
    console.log(`${hit ? "OK  " : "FAIL"}  ${ref}`);
  }
  console.log("--- manifest ---");
  console.log("engines:", JSON.stringify(pkg.engines));
  console.log("dsh.bundle.patch:", pkg.dsh?.bundle?.patch, "| dsh.client.platform:", pkg.dsh?.client?.platform);
  console.log("private:", pkg.private === true);
}

console.log("---");
console.log("payload files:", entries.length);
console.log("RESULT:", ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
