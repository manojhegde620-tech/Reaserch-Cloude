// T-Rex SEALED FILES — the data T-Rex keeps on GitHub (company files, AI deep reading, World watch, the market-data copy)
// is stored encrypted when the secret DATA_KEY is set (GitHub Actions secret + the same value as a Cloudflare secret).
// AES-256-GCM; each day has its own key = HMAC-SHA256(DATA_KEY, "trex-gh|YYYY-MM-DD"). The app gets the day keys it needs
// from T-Rex (/api/datakey) — only for people who are allowed into T-Rex. Never the DATA_KEY itself.
// A file looks like {"_s":1,"d":"2026-11-03","t":…,"iv":"…","c":"…"}; files without "_s" are plain (older) files and are read as they are.
// Also a small tool: `node collector/seal.mjs <branch>` seals every plain file of a branch and replaces the branch
// with one commit (so the plain copies are no longer in its history).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, statSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const C = globalThis.crypto.subtle;
const te = new TextEncoder(), td = new TextDecoder();
const b64 = u8 => Buffer.from(u8).toString("base64");
const unb64 = s => new Uint8Array(Buffer.from(String(s), "base64"));
export const dayOf = (t = Date.now()) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);   // IST day
export function sealOn(master = process.env.DATA_KEY) { return String(master || "").length >= 24; }
const _dk = new Map();
export async function dayKeyRaw(master, day) {
  const k = await C.importKey("raw", te.encode(String(master)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await C.sign("HMAC", k, te.encode("trex-gh|" + day)));
}
async function dayKey(master, day) {
  const id = String(master) + "|" + day; if (_dk.has(id)) return _dk.get(id);
  const k = await C.importKey("raw", await dayKeyRaw(master, day), "AES-GCM", false, ["encrypt", "decrypt"]); _dk.set(id, k); if (_dk.size > 400) _dk.clear(); return k;
}
export const isSealed = o => !!(o && typeof o === "object" && o._s === 1 && o.iv && o.c && o.d);
// object → text for the file (plain JSON when DATA_KEY is not set)
export async function sealText(obj, master = process.env.DATA_KEY, now = Date.now()) {
  const plain = JSON.stringify(obj); if (!sealOn(master)) return plain;
  const d = dayOf(now), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const c = new Uint8Array(await C.encrypt({ name: "AES-GCM", iv, additionalData: te.encode("trex-gh|" + d) }, await dayKey(master, d), te.encode(plain)));
  return JSON.stringify({ _s: 1, d, t: (obj && obj.t) || now, iv: b64(iv), c: b64(c) });
}
// file text (sealed or plain) → object (null when it cannot be read)
export async function openText(text, master = process.env.DATA_KEY) {
  let o; try { o = JSON.parse(text); } catch (e) { return null; }
  if (!isSealed(o)) return o;
  if (!sealOn(master)) return null;
  try { const p = await C.decrypt({ name: "AES-GCM", iv: unb64(o.iv), additionalData: te.encode("trex-gh|" + o.d) }, await dayKey(master, o.d), unb64(o.c)); return JSON.parse(td.decode(p)); }
  catch (e) { return null; }
}
export async function openFile(path, master = process.env.DATA_KEY) { try { return await openText(readFileSync(path, "utf8"), master); } catch (e) { return null; } }
export async function sealFile(path, obj, master = process.env.DATA_KEY, now = Date.now()) { writeFileSync(path, await sealText(obj, master, now)); }
// seal every plain .json file under a folder (keep: names that must stay plain) → number sealed
export async function sealTree(dir, master = process.env.DATA_KEY, keep = new Set()) {
  if (!sealOn(master)) return 0; let n = 0;
  const walk = async p => { for (const f of readdirSync(p)) { if (f === ".git") continue; const q = join(p, f);
    if (statSync(q).isDirectory()) await walk(q);
    else if (f.endsWith(".json") && !keep.has(f)) { const txt = readFileSync(q, "utf8"); let o; try { o = JSON.parse(txt); } catch (e) { continue; } if (isSealed(o)) continue; writeFileSync(q, await sealText(o, master)); n++; } } };
  await walk(dir); return n;
}

// CLI: seal a whole branch once and replace it with a single commit
async function sealBranch(branch) {
  const repo = process.env.GITHUB_REPOSITORY, tok = process.env.GITHUB_TOKEN, log = m => console.log(new Date().toISOString().slice(11, 19) + "  " + m);
  if (!sealOn()) { log("Sealing: DATA_KEY is not set — nothing to do."); return; }
  if (!repo || !tok) { log("Sealing: GITHUB_REPOSITORY / GITHUB_TOKEN missing."); return; }
  const dir = "seal-" + branch.replace(/[^a-z0-9-]/gi, ""); rmSync(dir, { recursive: true, force: true });
  const remote = `https://x-access-token:${tok}@github.com/${repo}.git`, git = (...a) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  try { execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", branch, remote, dir], { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { log("Sealing: branch " + branch + " not found."); return; }
  const keep = new Set(branch === "co-data" ? ["_state.json"] : branch === "gh-pages" ? ["manifest.json"] : []);
  const n = await sealTree(dir, process.env.DATA_KEY, keep);
  if (!n) { log(`Sealing: ${branch} — already sealed.`); rmSync(dir, { recursive: true, force: true }); return; }
  git("config", "user.name", "T-Rex collector"); git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  git("add", "-A"); const tree = git("write-tree"); const c = git("commit-tree", tree, "-m", `sealed (${n} files)`); git("update-ref", "HEAD", c);
  try { git("push", "--quiet", "--force", "origin", "HEAD:" + branch); log(`Sealing: ${branch} — ${n} plain files sealed; the branch now has one commit.`); }
  catch (e) { log("Sealing: could not save " + branch + ": " + String((e.stderr && e.stderr.toString()) || e.message || e).replace(/x-access-token:[^@]+@/g, "x-access-token:***@").slice(0, 200)); }
  rmSync(dir, { recursive: true, force: true });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) (async () => { for (const b of process.argv.slice(2)) await sealBranch(b); })().then(() => process.exit(0)).catch(e => { console.error(String(e && e.message || e)); process.exit(0); });
