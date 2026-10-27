#!/usr/bin/env node
/**
 * 把 sources.json 里登记的每个作者仓库的 evejs-mod.json 抓下来，合并成一份
 * **签名过的** mod-index.json，输出到 docs/（GitHub Pages 从这里发布）。
 *
 * 用法：  INDEX_SIGNING_KEY="<PKCS8 PEM>" node scripts/build-index.mjs
 * 依赖：  无（只用 node 内置模块）
 *
 * 归属三原则（防"改署名/抢注"，见 launcher 的 docs/mod-signing-and-marketplace-plan.md §7.6）：
 *   1. id 全局唯一、先到先得 —— 同一个 id 只有 sources.json 里**第一次**出现的那个仓库能更新它
 *   2. author.id ↔ 公钥绑定 —— 同一个 author.id 第一次用哪把 keyId，之后就只能是那把（记在 author-keys.json）
 *   3. 来源可见 —— 每条写进 source 字段（owner/repo），客户端会展示
 * 不合格的条目会被**跳过并打印**，不会污染索引；其余条目照常发布。
 *
 * 维护者审核（moderation.json，见 scripts/moderate.mjs）：
 *   action=reject → 该条目/来源**不进索引**（拒绝收录），拒绝原因照样发布，作者在启动器里能看到；
 *   action=delist → 条目仍进索引但标记 delisted（从市场下架），客户端显示「已下架」并禁止安装。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const SOURCES_FILE = path.join(ROOT, "sources.json");
const AUTHOR_KEYS_FILE = path.join(ROOT, "author-keys.json");
const MODERATION_FILE = path.join(ROOT, "moderation.json");
const MODS_DIR = path.join(ROOT, "mods");
const OUT_DIR = path.join(ROOT, "docs");
const OUT_FILE = path.join(OUT_DIR, "mod-index.json");
const LISTING_NAME = "evejs-mod.json";
const FETCH_TIMEOUT_MS = 15000;

/**
 * 上一次发布的索引里的下载量 —— 给 `downloads` 加一道「**只增不减**」的护栏。
 *
 * 为什么需要（2026-10-23 实测）：GitHub 的 Release 资产 `download_count` **会间歇性报 0**。
 * 同一次构建里 8 个模组拿到真值（609 / 175 / 150 …），**33 个全是 0**；
 * 稍后用**同样的接口、同样的仓库**重查，那些「0」全都有真实值
 * （`evejs-automining` 749、`evejs-autolockfire` 830、`evejs-faction-sim` 1082）。
 * 不是权限、不是限流、不是仓库地址 —— 就是计数没刷出来。
 *
 * 下载数是**累计值**：作者每发一个新版本只会往上加。所以「变小」只可能是取数出错，
 * 此时沿用上一次的值，别让模组的下载量凭空消失（上一版就是这么丢的）。
 */
const previousDownloads = new Map();
try {
  const previous = JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
  for (const item of Array.isArray(previous.mods) ? previous.mods : []) {
    if (typeof item.downloads === "number" && item.downloads > 0) {
      previousDownloads.set(item.id, item.downloads);
    }
  }
} catch {
  // 第一次构建没有上一份，正常
}
let downloadsRefreshed = 0;
let downloadsPreserved = 0;
let downloadsZero = 0;

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/** 与启动器 modSigner.canonicalManifestJson 完全一致：去掉 signature 后按 key 升序序列化 */
function canonicalJson(obj) {
  const { signature: _omit, ...rest } = obj;
  return JSON.stringify(sortKeysDeep(rest));
}

function keyIdFromRaw(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/**
 * 取默认分支最新 commit SHA。
 * 为什么要它：jsDelivr 对「分支引用」(@main) 有最长约 12 小时缓存，作者刚发新版时
 * 索引会抓到旧清单（实测踩过：索引里留着已删除的旧版本地址 → 用户安装 404）。
 * 用 @<commit-sha> 是每个 commit 一个不可变地址，CDN 缓存命中的也是当前版本。
 */
async function fetchHeadSha(repo) {
  const token = process.env.GH_API_TOKEN || process.env.GITHUB_TOKEN || "";
  const headers = { "User-Agent": "EveJS-mods-index", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = "Bearer " + token;
  try {
    const res = await fetch("https://api.github.com/repos/" + repo + "/commits?per_page=1", {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return "";
    const list = await res.json();
    return Array.isArray(list) && list[0] && typeof list[0].sha === "string" ? list[0].sha : "";
  } catch {
    return "";
  }
}

/**
 * 目录里能当图片用的后缀。**按后缀发现，不认文件名** —— 作者可能写 banner.jpg、
 * cover.png、封面.webp，硬编码某个名字必然漏。
 */
const IMAGE_EXT_RE = /\.(webp|png|jpe?g|gif)$/i;

/**
 * 列出作者仓库某个目录下的文件（只返回图片），返回仓库内相对路径。
 *
 * 为什么要这一层：`shots` 与 `shots/Banner` 里的图**文件名由作者随便起**，
 * 而 `evejs-mod.json` 未必声明了它们（作者先放图、后补清单，或者干脆没走发布链路）。
 * 索引侧既然能读到仓库，就按**后缀**把图找出来，而不是假设某一张叫 banner.jpg。
 *
 * 走 GitHub contents API（带 token 时 5000 次/小时）；失败返回空数组，
 * 调用方保持原样，不因为读不到目录就把已有的 shots/banner 抹掉。
 */
async function listImageFiles(repo, dir) {
  const token = process.env.GH_API_TOKEN || process.env.GITHUB_TOKEN || "";
  const headers = { "User-Agent": "EveJS-mods-index", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = "Bearer " + token;
  try {
    const res = await fetch(
      "https://api.github.com/repos/" + repo + "/contents/" + dir.split("/").map(encodeURIComponent).join("/"),
      { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    if (!res.ok) return [];
    const list = await res.json();
    if (!Array.isArray(list)) return [];
    return list
      .filter((item) => item && item.type === "file" && typeof item.name === "string")
      .filter((item) => IMAGE_EXT_RE.test(item.name))
      .map((item) => dir.replace(/\/+$/, "") + "/" + item.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 找出作者仓库里的精选横幅。
 *
 * 顺序：
 *   1. `shots/Banner/` 下的**任意后缀图片**（多张时挑文件名里像素最宽的那张，
 *      例如 banner-1920x600.png 优于 banner-1280x400.png；认不出尺寸就按字典序取第一张）；
 *   2. 退一步：`shots/` 根目录里文件名含 banner/cover/封面 字样的图（老作者的习惯写法）。
 *
 * 都没有就返回空字符串 —— 前端会退回本地兜底横幅，不留空白。
 */
async function discoverBanner(repo) {
  const bannerDir = await listImageFiles(repo, "shots/Banner");
  if (bannerDir.length) return pickWidest(bannerDir);

  const root = await listImageFiles(repo, "shots");
  const named = root.filter((p) => /(^|\/)(banner|cover|封面)/i.test(p));
  return named.length ? pickWidest(named) : "";
}

/** 从文件名里读 `<宽>x<高>`，按宽度降序；读不到尺寸的按字典序垫后 */
/**
 * 分片清单归一化：只留 https 直链，sha256 必须是 64 位 hex，sizeBytes 必须是正数。
 *
 * 形状（与启动器 `ui` 侧、Rust 侧 `registry::parts_of` 一致）：
 *   { total, parts: [{ url, sizeBytes, sha256, mirror }] }
 * 审核/作者手写时也接受裸数组，省一层壳。
 *
 * 为什么要过滤：分片地址会原样进 `mod-index.json` 并被启动器直接下载，
 * 这里放过一个 http:// 或不合法的 sha256，等于把校验推给每个客户端。
 */
function normaliseParts(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.parts) ? value.parts : [];
  return list
    .filter((item) => item && typeof item.url === "string" && /^https:\/\//i.test(item.url))
    .map((item) => {
      const part = { url: item.url };
      if (typeof item.sha256 === "string" && /^[0-9a-f]{64}$/i.test(item.sha256)) {
        part.sha256 = item.sha256.toLowerCase();
      }
      if (Number.isFinite(item.sizeBytes) && item.sizeBytes > 0) part.sizeBytes = item.sizeBytes;
      if (typeof item.mirror === "string" && item.mirror.trim()) part.mirror = item.mirror.trim();
      return part;
    });
}

function pickWidest(paths) {
  const widthOf = (p) => {
    const name = p.split("/").pop() || "";
    const m = name.toLowerCase().match(/(\d{2,5})\s*x\s*(\d{2,5})/);
    return m ? Number(m[1]) : 0;
  };
  return [...paths].sort((a, b) => widthOf(b) - widthOf(a) || a.localeCompare(b))[0];
}

/** 兜底：直接问 GitHub API 要清单内容（完全无 CDN 缓存） */
async function fetchListingViaApi(repo) {
  const token = process.env.GH_API_TOKEN || process.env.GITHUB_TOKEN || "";
  const headers = { "User-Agent": "EveJS-mods-index", Accept: "application/vnd.github.raw" };
  if (token) headers.Authorization = "Bearer " + token;
  try {
    const res = await fetch("https://api.github.com/repos/" + repo + "/contents/" + LISTING_NAME, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
    return { ok: true, data: JSON.parse(await res.text()) };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "EveJS-mods-index" }, signal: controller.signal });
    if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, reason: e?.name === "AbortError" ? "超时" : String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 统计一个仓库所有 Release 资产的下载次数（GitHub 官方计数，含重复下载）。
 * 注意：只有「把 ZIP 传到 Release」的模组才统计得到；直接把 ZIP 放仓库文件（raw/jsDelivr）是没有计数的。
 * 匿名 API 限 60 次/小时，所以 CI 里会带 GITHUB_TOKEN（5000 次/小时）。
 */
async function fetchReleaseDownloads(repo) {
  const token = process.env.GH_API_TOKEN || "";
  const headers = { "User-Agent": "EveJS-mods-index", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = "Bearer " + token;
  try {
    const res = await fetch("https://api.github.com/repos/" + repo + "/releases?per_page=100", { headers });
    if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
    const list = await res.json();
    let total = 0, latestAt = "";
    for (const r of Array.isArray(list) ? list : []) {
      for (const a of Array.isArray(r.assets) ? r.assets : []) total += Number(a.download_count) || 0;
      const at = r.published_at || r.created_at || "";
      if (at && (!latestAt || Date.parse(at) > Date.parse(latestAt))) latestAt = at;
    }
    return { ok: true, total, latestAt };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

/**
 * jsDelivr CDN 命中次数（次选来源）。
 * 启动器的下载镜像顺序是 jsDelivr → raw → github，所以「ZIP 直接放仓库文件」的模组
 * 也能在这里拿到真实计数（Release 资产那条路统计不到它们）。
 * 注意：只有经 jsDelivr CDN 的请求才算，直连 raw.githubusercontent.com 不计入。
 */
async function fetchJsdelivrHits(repo) {
  try {
    const res = await fetch("https://data.jsdelivr.com/v1/stats/packages/gh/" + repo, {
      headers: { "User-Agent": "EveJS-mods-index", Accept: "application/json" }
    });
    if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
    const data = await res.json();
    const total = Number(data && data.hits ? data.hits.total : NaN);
    return Number.isFinite(total) ? { ok: true, total } : { ok: false, reason: "响应里没有 hits.total" };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

/**
 * sources.json 是所有人共用的一份清单，作者端重试、分支落后于 main 都可能写进重复项：
 *   · 同一条来源出现两次（启动器重试时把同一行又追加了一遍）
 *   · 同一个仓库大小写不同（Owner/Repo 与 owner/repo，看起来是两条，其实是同一个）
 * 重复项会让下面重复抓仓库（浪费额度）、也会让「来源数」虚高，所以这里统一归一化：
 * 去空白、丢掉格式不合法的、按**不区分大小写**去重（保留第一次出现的写法与顺序）。
 * 数组内容真的变了才写回文件，交给 workflow 一起提交 —— 只改格式不会触发重写，免得来回打架。
 */
const sourcesDoc = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    console.error("读不到或解析不了 sources.json，按空列表处理");
    return null;
  }
})();

const sourcesRaw = sourcesDoc && Array.isArray(sourcesDoc.sources) ? sourcesDoc.sources : [];
const sources = [];
const normalizedSources = [];
const seenSources = new Set();
const droppedSources = [];
for (const item of sourcesRaw) {
  const text = typeof item === "string" ? item.trim() : "";
  if (!text || !/^[\w.-]+\/[\w.-]+$/.test(text)) { droppedSources.push(typeof item === "string" ? text || "(空)" : "(非字符串)"); continue; }
  const key = text.toLowerCase();
  if (seenSources.has(key)) { droppedSources.push(text); continue; }
  seenSources.add(key);
  normalizedSources.push(text);
  sources.push(text);
}
if (sourcesDoc && JSON.stringify(sourcesDoc.sources) !== JSON.stringify(normalizedSources)) {
  sourcesDoc.sources = normalizedSources;
  fs.writeFileSync(SOURCES_FILE, JSON.stringify(sourcesDoc, null, 2) + "\n", "utf8");
  console.log("sources.json 已归一化：去掉 " + droppedSources.length + " 条重复/非法来源 —— " + droppedSources.join(", "));
}

const authorKeys = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTHOR_KEYS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
})();

/**
 * 版本记录：`mods/<id>.json`（启动器的「提交审核」每次发布都会往这个目录提一条 PR）。
 *
 * 记录里写的是"哪一版已经被维护者合并"：构建时用它覆盖作者仓库存清单里的
 * 版本号 / sha256 / 下载地址，所以**没合并的版本不会进市场** —— 审核门就落在这里。
 * 目录不存在（或记录里没有这个 id）＝按老路子走：只信作者仓库的 `evejs-mod.json`。
 */
const modRecords = (() => {
  const map = new Map();
  let names = [];
  try {
    names = fs.readdirSync(MODS_DIR);
  } catch {
    return map; // 还没有 mods/ 目录：正常，全部按老路子
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const shown = "mods/" + name;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(MODS_DIR, name), "utf8"));
      const id = parsed && typeof parsed.id === "string" ? parsed.id.trim() : "";
      if (!id) { console.warn("跳过 " + shown + "：缺 id"); continue; }
      const key = id.toLowerCase();
      if (map.has(key)) {
        console.warn("跳过 " + shown + "：id「" + id + "」已经有记录了（" + map.get(key).__file + "）");
        continue;
      }
      map.set(key, { ...parsed, __file: shown });
    } catch (e) {
      console.warn("跳过 " + shown + "：" + (e && e.message ? e.message : e));
    }
  }
  if (map.size) console.log("读到版本记录 " + map.size + " 条（mods/）");
  return map;
})();

/**
 * 本地清单覆盖（可选）：INDEX_LOCAL_LISTINGS="owner/repo=/abs/path/evejs-mod.json;owner2/repo2=/abs/..."
 * 用途：本地/离线构建时，不依赖 CDN（jsDelivr 对分支引用有最长约 12h 缓存，刚改完清单时读到的可能是旧的）。
 */
const LOCAL_LISTINGS = (process.env.INDEX_LOCAL_LISTINGS || "")
  .split(";")
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => { const i = x.indexOf("="); return i > 0 ? { repo: x.slice(0, i).trim().toLowerCase(), path: x.slice(i + 1).trim() } : null; })
  .filter(Boolean);

/**
 * 维护者审核规则：moderation.json
 *   { entries: [ { target, kind:"id"|"source", action:"reject"|"delist", reason:{zh,en}, at, by } ] }
 * target 是模组 id（kind=id）或 owner/repo（kind=source）。
 */
const moderationRules = (() => {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODERATION_FILE, "utf8"));
    const list = Array.isArray(parsed.entries) ? parsed.entries : [];
    return list.filter((e) => e && typeof e.target === "string" && e.target.trim() &&
      (e.action === "reject" || e.action === "delist"));
  } catch {
    return [];   // 没有这个文件 = 全部放行
  }
})();

function reasonsOf(rule) {
  const r = rule && rule.reason && typeof rule.reason === "object" ? rule.reason : {};
  return { zh: String(r.zh || ""), en: String(r.en || r.zh || "") };
}

/**
 * 旧版「永久除名」写进 moderation.json 的 permanent 标记，这里只做向后兼容的透传：
 * 老数据里还有几条带这个标记的记录，索引照原样发布，客户端才不会解读成别的东西。
 * 新逻辑不再产生它 —— 永久删除会把来源从 sources.json 移除、moderation.json 记录一并清掉，
 * 不留黑名单，作者重新用启动器发布提交就是一次全新的收录。
 */
function permanentOf(rule) {
  return rule && rule.permanent === true ? { permanent: true } : {};
}

function ruleFor(kind, target) {
  const t = String(target || "").trim().toLowerCase();
  if (!t) return null;
  const hit = moderationRules.filter((e) => (e.kind === "source" ? "source" : "id") === kind &&
    String(e.target).trim().toLowerCase() === t);
  return hit.length ? hit[hit.length - 1] : null;   // 同目标多条时以最后一条为准
}

const mods = [];
const moderationLog = {};   // 会原样发布进索引，作者据此看到原因
const byId = new Map();
const rejected = [];
let authorKeysChanged = false;

for (const repo of sources) {
  // 来源级审核：整仓被拒绝收录 → 不抓取、不进索引，但原因照样发布
  const srcRule = ruleFor("source", repo);
  if (srcRule && srcRule.action === "reject") {
    rejected.push({ repo, reason: "维护者已拒绝收录：" + (reasonsOf(srcRule).zh || "未填写原因") });
    moderationLog[repo] = { source: repo, action: "reject", reason: reasonsOf(srcRule), at: srcRule.at || "", by: srcRule.by || "", ...permanentOf(srcRule) };
    continue;
  }
  // 多镜像候选（顺序 = 新鲜度）：
  //   1) raw 直连 + 时间戳（raw 本身不走 CDN，时间戳再挡一层代理缓存）
  //   2) jsDelivr 用 @<commit-sha>（不可变引用，**不会**命中 @main 的 12h 分支缓存）
  //   3) jsDelivr @main（国内可达性好，但可能是旧的）
  //   4) github.com/raw 兜底
  const headSha = await fetchHeadSha(repo);
  const stamp = Date.now();
  const candidates = [
    "https://raw.githubusercontent.com/" + repo + "/HEAD/" + LISTING_NAME + "?t=" + stamp,
    ...(headSha ? ["https://cdn.jsdelivr.net/gh/" + repo + "@" + headSha + "/" + LISTING_NAME] : []),
    "https://cdn.jsdelivr.net/gh/" + repo + "@main/" + LISTING_NAME,
    "https://github.com/" + repo + "/raw/HEAD/" + LISTING_NAME + "?t=" + stamp
  ];
  let entry = null;
  let entrySource = "";
  const failures = [];
  const local = LOCAL_LISTINGS.find((l) => l.repo === repo.toLowerCase());
  if (local) {
    try {
      entry = JSON.parse(fs.readFileSync(local.path, "utf8"));
      console.log("（用本地清单）" + repo + " ← " + local.path);
    } catch (e) {
      console.warn("本地清单读取失败，回退到联网抓取：" + (e && e.message ? e.message : e));
      entry = null;
    }
  }
  for (const url of entry ? [] : candidates) {
    const res = await fetchJson(url);
    if (res.ok && res.data && typeof res.data === "object") { entry = res.data; entrySource = url; break; }
    failures.push(url.replace(/^https:\/\//, "").split("/").slice(0, 1)[0] + "→" + (res.reason || "失败"));
  }
  if (!entry) {
    // 兜底：直接问 GitHub API（无 CDN 缓存），CI 里有 GITHUB_TOKEN
    const viaApi = await fetchListingViaApi(repo);
    if (viaApi.ok && viaApi.data && typeof viaApi.data === "object") {
      entry = viaApi.data;
      entrySource = "api.github.com/contents";
      console.log("（API 兜底）" + repo + " ← api.github.com contents");
    } else {
      failures.push("api→" + (viaApi.reason || "失败"));
    }
  }
  if (!entry) {
    rejected.push({ repo, reason: "抓不到 " + LISTING_NAME + "（" + failures.join("；") + "）" });
    continue;
  }
  if (!entry || typeof entry !== "object") { rejected.push({ repo, reason: "不是 JSON 对象" }); continue; }
  if (entrySource) {
    const label = entrySource.includes("/" + (entrySource.match(/@([0-9a-f]{7,40})\//) || [, ""])[1]) && entrySource.includes("jsdelivr")
      ? "jsDelivr@commit"
      : entrySource.includes("jsdelivr") ? "jsDelivr@main"
      : entrySource.includes("raw.githubusercontent") ? "raw(带时间戳)" : "github raw";
    console.log("  " + repo + " 清单来源：" + label + "（v" + String(entry.version || "?") + "）");
  }
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) { rejected.push({ repo, reason: "缺 id" }); continue; }

  // 已合并的版本记录是该来源的权威版本：覆盖清单里的版本号 / 摘要 / 下载地址。
  const record = modRecords.get(id.toLowerCase());
  if (record) {
    const recordSource = String(record.source || "").trim();
    if (recordSource.toLowerCase() !== repo.toLowerCase()) {
      rejected.push({ repo, reason: record.__file + " 里记录的来源是「" + recordSource + "」，不是这个仓库" });
      continue;
    }
    if (typeof record.version === "string" && record.version.trim()) entry.version = record.version.trim();
    if (typeof record.sha256 === "string" && /^[0-9a-f]{64}$/i.test(record.sha256.trim())) {
      entry.sha256 = record.sha256.trim().toLowerCase();
    }
    if (typeof record.sizeBytes === "number" && record.sizeBytes > 0) entry.sizeBytes = record.sizeBytes;
    if (Array.isArray(record.downloadUrls) && record.downloadUrls.length) entry.downloadUrls = record.downloadUrls;
    // 分片包（>2 GiB，GitHub 单资产上限的出路）：记录里的分片清单同样是**权威来源**。
    // 形状与启动器一致：{ total, parts: [{ url, sizeBytes, sha256, mirror }] }（也接受裸数组）。
    const recordParts = normaliseParts(record.downloadParts ?? record.parts);
    if (recordParts.length) entry.downloadParts = { total: recordParts.length, parts: recordParts };
    if (typeof record.publishedAt === "string" && record.publishedAt.trim()) entry.publishedAt = record.publishedAt.trim();
    // 截图与精选横幅：**作者仓库的 `evejs-mod.json` 仍是主来源**，但有一类情况需要维护者兜底 ——
    // 作者把图放进 shots/（甚至 shots/Banner/）之后没有重新发布，清单里就没有这两个字段，
    // 而索引 CI 只抓清单，于是图明明在仓库里、市场里却一张都不显示。
    // 允许在分片里补一份：只认"分片里有、且形状合法"的情况；分片没写就完全不动 entry，行为与以前一致。
    // 1) 分片显式声明优先（维护者可以精确控制顺序）
    if (Array.isArray(record.shots) && record.shots.length) {
      const shots = record.shots
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim());
      if (shots.length) entry.shots = shots;
    }
    if (typeof record.banner === "string" && record.banner.trim()) entry.banner = record.banner.trim();
    if (Array.isArray(record.banners) && record.banners.length) {
      const banners = record.banners
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => item.trim());
      if (banners.length) entry.banners = banners;
    }
    // 2) 分片没声明，但作者仓库里明明有图 → 按**后缀**把 shots/ 里的图找出来。
    //    这正是"图在仓库里、市场里却一张都不显示"的成因：清单没写，索引就没得抓。
    //    只补缺，不覆盖：清单里已经声明的 shots 一律不动。
    if (!Array.isArray(entry.shots) || entry.shots.length === 0) {
      const discovered = await listImageFiles(repo, "shots");
      if (discovered.length) {
        entry.shots = discovered;
        console.log("  " + id + "：清单没声明截图，按后缀从 shots/ 发现 " + discovered.length + " 张");
      }
    }
    // 3) 横幅同理：分片/清单都没有时，去 shots/Banner/ 按后缀找，找不到再退回
    //    shots/ 根目录里名字像横幅的那张。
    if (typeof entry.banner !== "string" || !entry.banner.trim()) {
      const banner = await discoverBanner(repo);
      if (banner) {
        entry.banner = banner;
        console.log("  " + id + "：清单没声明横幅，按后缀发现 " + banner);
      }
    }
    console.log("  " + id + "：采用已合并的版本记录 " + record.__file + "（v" + entry.version + "）");
  }

  const version = typeof entry.version === "string" ? entry.version.trim() : "";
  const sha256 = typeof entry.sha256 === "string" ? entry.sha256.trim().toLowerCase() : "";
  if (!version) { rejected.push({ repo, reason: "缺 version" }); continue; }
  if (!/^[0-9a-f]{64}$/.test(sha256)) { rejected.push({ repo, reason: "sha256 不是 64 位 hex" }); continue; }

  // 原则 1：id 先到先得
  if (byId.has(id)) {
    rejected.push({ repo, reason: "id「" + id + "」已被 " + byId.get(id) + " 占用（先到先得）" });
    continue;
  }

  // 原则 2：author.id ↔ 公钥绑定
  const author = entry.author && typeof entry.author === "object" ? entry.author : {};
  const authorId = typeof author.id === "string" ? author.id.trim() : "";
  const keyId = typeof author.keyId === "string" ? author.keyId.trim() : "";
  const publicKey = typeof author.publicKey === "string" ? author.publicKey.trim() : "";
  if (authorId) {
    const known = authorKeys[authorId];
    if (!known) {
      authorKeys[authorId] = { keyId, publicKey, repo, firstSeen: new Date().toISOString().slice(0, 10) };
      authorKeysChanged = true;
    } else if (keyId && known.keyId && keyId !== known.keyId) {
      rejected.push({ repo, reason: "author.id「" + authorId + "」已绑定 keyId " + known.keyId + "（提交的是 " + keyId + "）" });
      continue;
    }
  }

  const downloads = Array.isArray(entry.downloadUrls) ? entry.downloadUrls : [];
  const usable = downloads.filter((u) => u && typeof u.url === "string" && /^https:\/\//i.test(u.url));
  // 切片包**没有整包地址**是正常的：只要分片清单里有可用的 https 直链就该放行，
  // 否则「>2 GiB 的模组」会在这一步被整条拒收（2026-10-27 随分片传输一起补上）。
  const parts = normaliseParts(entry.downloadParts);
  if (!usable.length && !parts.length) { rejected.push({ repo, reason: "没有可用的 https 下载地址" }); continue; }

  byId.set(id, repo);
  const dl = await fetchReleaseDownloads(repo);
  const cdn = await fetchJsdelivrHits(repo);
  const withDl = {
    ...entry,
    source: repo,
    downloadUrls: usable,
    ...(parts.length ? { downloadParts: { total: parts.length, parts } } : {}),
  };
  const previousDownloadCount = previousDownloads.get(id) || 0;
  if (dl.ok || cdn.ok) {
    // 只统计 GitHub Release 资产的下载次数：这是作者真正发布 ZIP 的通道，一次下载=一次安装；
    // jsDelivr 的 packages 命中数包含启动器拉 evejs-mod.json、检查更新等非下载请求，混在一起会虚高（实测 14 次安装被算成 23）。
    // 因此它只作为参考值存进 cdnHits，不计入下载量。
    if (dl.ok) {
      // 「只增不减」护栏：`download_count` 是累计值，回落（尤其归 0）只可能是取数出错。
      // 见文件头 `previousDownloads` 的注释（2026-10-23 那次 33 个模组被写成 0）。
      if (dl.total > 0) {
        withDl.downloads = dl.total;
        downloadsRefreshed += 1;
        if (dl.total < previousDownloadCount) {
          // 不拦、照实写，但要让维护者能看见：真降了通常意味着换了 Release / 迁移了仓库
          console.log("  " + id + "：本次 " + dl.total + " 比上次 " + previousDownloadCount +
            " 小 —— 照实写，建议人工核一眼");
        }
      } else if (previousDownloadCount > 0) {
        withDl.downloads = previousDownloadCount;
        downloadsPreserved += 1;
        console.log("  " + id + "：GitHub 这次报 0（累计值不可能回落）→ 沿用上次的 " + previousDownloadCount);
      } else {
        // 真·新模组、且确实还没人下：照实 0，前端会显示「—」
        withDl.downloads = 0;
        downloadsZero += 1;
      }
    }
    if (cdn.ok) withDl.cdnHits = cdn.total;
    console.log("  " + id + "：下载 " + withDl.downloads + " 次（Release " + (dl.ok ? dl.total : "未统计") +
      (cdn.ok ? "；jsDelivr 命中 " + cdn.total + " 次（含检查更新，不计入下载）" : "") + "）");
  } else {
    console.log("  " + id + "：下载次数未统计（Release: " + dl.reason + " / jsDelivr: " + cdn.reason + "）" +
      (previousDownloadCount > 0 ? " → 沿用上次的 " + previousDownloadCount : " → 留空（前端显示 —）"));
    if (previousDownloadCount > 0) {
      withDl.downloads = previousDownloadCount;
      downloadsPreserved += 1;
    }
  }
  // 条目级审核：id 规则优先，其次来源规则
  const rule = ruleFor("id", id) || ruleFor("source", repo);
  if (rule && rule.action === "reject") {
    rejected.push({ repo, reason: "维护者已拒绝收录 id「" + id + "」：" + (reasonsOf(rule).zh || "未填写原因") });
    moderationLog[id] = { id, source: repo, authorId, action: "reject", reason: reasonsOf(rule), at: rule.at || "", by: rule.by || "", ...permanentOf(rule) };
    continue;
  }
  if (rule && rule.action === "delist") {
    withDl.delisted = true;
    withDl.delistReason = reasonsOf(rule);
    withDl.moderatedAt = rule.at || "";
    withDl.moderatedBy = rule.by || "";
    moderationLog[id] = { id, source: repo, authorId, action: "delist", reason: reasonsOf(rule), at: rule.at || "", by: rule.by || "" };
    console.log("  " + id + "：已被维护者下架（" + (reasonsOf(rule).zh || "未填写原因") + "）");
  }
  mods.push(withDl);
}

mods.sort((a, b) => String(a.displayName || a.id).localeCompare(String(b.displayName || b.id)));

// 来源级「拒绝收录」会同时把来源从 sources.json 移除（控制台的同步接口就是这么写的），
// 上面的循环因此再也见不到它，moderationLog 里就永远没有这条结论 —— 作者的启动器既看不到
// 「已驳回」也看不到理由（2026-09-29 报障：已下架改成拒绝收录后状态不切换、理由不显示）。
// 索引是客户端唯一的信息来源，所以这里把「已经不在名单里」的拒绝结论照样发布一份。
// 名单内已发布的（带 id / authorId，信息更全）不覆盖。
const loggedKeys = new Set(Object.keys(moderationLog).map((key) => key.toLowerCase()));
for (const rule of moderationRules) {
  if (rule.action !== "reject") continue;
  const kind = rule.kind === "source" ? "source" : "id";
  const target = String(rule.target).trim();
  if (!target || loggedKeys.has(target.toLowerCase())) continue;
  moderationLog[target] = kind === "source"
    ? { source: target, action: "reject", reason: reasonsOf(rule), at: rule.at || "", by: rule.by || "", ...permanentOf(rule) }
    : { id: target, action: "reject", reason: reasonsOf(rule), at: rule.at || "", by: rule.by || "", ...permanentOf(rule) };
  loggedKeys.add(target.toLowerCase());
}

const index = { schemaVersion: 1, publishedAt: new Date().toISOString(), mods };
if (Object.keys(moderationLog).length) index.moderation = moderationLog;

const pem = (process.env.INDEX_SIGNING_KEY || "").replace(/\\n/g, "\n").trim();
if (!pem) {
  console.error("缺少环境变量 INDEX_SIGNING_KEY（私钥 PEM）。本地调试可临时用它跑一次。");
  process.exit(2);
}
let privateKey;
try {
  privateKey = crypto.createPrivateKey(pem);
} catch (e) {
  console.error("私钥解析失败：" + (e && e.message ? e.message : e));
  process.exit(2);
}
const spki = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
const raw = spki.subarray(spki.length - 32);
const keyId = keyIdFromRaw(raw);
const sig = crypto.sign(null, Buffer.from(canonicalJson(index), "utf8"), privateKey).toString("base64");
index.signature = { alg: "ed25519", keyId, sig, signedAt: new Date().toISOString() };

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(index, null, 2) + "\n", "utf8");
try {
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), "<!doctype html><meta charset=\"utf-8\"><title>EVEjs mods index</title><p>这是 EvEJS 启动器的模组索引，入口是 <a href=\"./mod-index.json\">mod-index.json</a>。\n", "utf8");
} catch { /* 可选 */ }

if (authorKeysChanged) {
  fs.writeFileSync(AUTHOR_KEYS_FILE, JSON.stringify(authorKeys, null, 2) + "\n", "utf8");
}

console.log("索引已生成：" + OUT_FILE);
console.log("  条目：" + mods.length + "  来源：" + sources.length + "  签名 keyId：" + keyId);
console.log("  下载量：刷新 " + downloadsRefreshed + " / 沿用上次 " + downloadsPreserved + " / 仍为 0 " + downloadsZero);
// 异常要有信号：一次构建里大半模组都没拿到真实计数，说明上游（GitHub 的资产计数）不对劲。
// 不 fail（索引必须继续发布，且护栏已保证数值不回落），但要让这一次运行「不静默」。
if (downloadsPreserved + downloadsZero > mods.length / 2) {
  console.log("::warning::本次 " + (downloadsPreserved + downloadsZero) + "/" + mods.length +
    " 个模组的下载数没拿到真值（沿用上次或为 0），请核一眼上游计数。");
}
if (rejected.length) {
  console.log("");
  console.log("=== 被跳过的来源（" + rejected.length + "）===");
  for (const r of rejected) console.log("  ✗ " + r.repo + " —— " + r.reason);
}
const moderated = Object.values(moderationLog);
if (moderated.length) {
  console.log("");
  console.log("=== 维护者审核（" + moderated.length + "）===");
  for (const m of moderated) console.log("  " + (m.action === "delist" ? "⛔ 下架" : "✗ 拒绝") + " " + (m.id || m.source) + " —— " + (m.reason.zh || "未填写原因"));
}
