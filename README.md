# EVEjs-mods — mod index for the EvEJS Launcher / EvEJS 启动器的模组索引仓库

The signed, serverless mod index that the [EvEJS Launcher](https://github.com/diguo520/EVEjs-launcher) reads.
[EvEJS 启动器](https://github.com/diguo520/EVEjs-launcher) 读取的签名模组索引，不需要任何服务器。

- Index file the launcher reads: <https://diguo520.github.io/EVEjs-mods/mod-index.json>
- Launcher repository: <https://github.com/diguo520/EVEjs-launcher>

**English** ｜ [中文](#中文)

---

## English

### What this repository does

This repository does exactly three things:

1. `sources.json` records which author repositories are listed;
2. CI periodically fetches each repository's `evejs-mod.json` and merges them into one **`mod-index.json`**;
3. CI signs that file with the private key kept in a repository secret and publishes it to GitHub Pages.

The launcher reads exactly one file:

```
https://diguo520.github.io/EVEjs-mods/mod-index.json
```

> **No server required.** The index is static JSON on GitHub Pages, and mod ZIPs are hosted in each author's own
> repository. Integrity comes from the `sha256` recorded in the index, and the index itself is signed with the
> maintainer's private key — the client **verifies the signature first and only then trusts any URL or hash inside it**.

### Repository layout

```
EVEjs-mods/
  sources.json                  which author repositories are listed
  author-keys.json              author.id <-> public key bindings (maintained by CI, prevents impersonation)
  moderation.json               maintainer decisions (reject / delist + reasons)
  scripts/
    keygen.mjs                  maintainer: generate the signing key pair (run once)
    build-index.mjs             fetch -> validate -> merge -> sign -> docs/mod-index.json
    moderate.mjs                reviewer CLI: list / approve / reject / delist / restore / pr-text
  .github/workflows/
    build-index.yml             every 6 hours + manual trigger + push trigger
    auto-merge-submissions.yml  validates incoming submission PRs and merges them unattended
    mirror-ratings.yml          hourly copy of the signed market snapshots into docs/ratings/
  docs/                         CI output, published by GitHub Pages (main branch / docs)
    mod-index.json
    ratings/                    fallback mirror of the market snapshots (ratings.json, sponsors.json, reviews/)
```

### How an author gets listed (one PR per release, reviewed here)

1. Put the mod source in their own repository and use the launcher's **Submit mod -> Publish to my repo**:
   the launcher writes `evejs-mod.json`, creates the Release and uploads the ZIP;
2. Use the launcher's **Submit for review** to open a PR against this index repository:
   - first release: `sources.json` (registers `<owner>/<repo>`) **and** `mods/<id>.json` (the version record);
   - every later release: `mods/<id>.json` only — the same `release/<id>` branch, so the open PR is refreshed
     instead of piling up one PR per version;
3. **Nobody needs to be at the computer**: `.github/workflows/auto-merge-submissions.yml` validates the PR
   against the checklist below and merges it on its own (see
   [Unattended submissions](#unattended-submissions-auto-merge-no-maintainer-needed)), or leaves one comment
   saying why it would not. A maintainer can of course still review and merge by hand. **Only accepted records go live**:
   `build-index.mjs` treats the merged `mods/<id>.json` as the authoritative version of that source,
   so the marketplace moves to a new version when the PR is merged (merging also triggers an immediate rebuild
   via the `mods/**` path filter; the 6-hourly run stays as a safety net).

### Unattended submissions (auto-merge, no maintainer needed)

`.github/workflows/auto-merge-submissions.yml` removes the "somebody has to sit at the computer and press Merge"
step: it checks every incoming submission PR against the rules below, merges it on its own, and then explicitly
dispatches `build-index` — the push the bot makes with `GITHUB_TOKEN` would not trigger another workflow by
itself (GitHub blocks that to prevent recursion), so the rebuild has to be requested by name.

- Triggered by `pull_request_target` (opened / synchronize / reopened / ready_for_review), plus a
  `repository_dispatch` event (`auto-merge-check`, with `client_payload.pr`) and a manual `workflow_dispatch`.
- Safe by construction: the workflow always comes from the base branch and **never checks out or runs the PR's
  code** — it only reads the PR's *data* through the API, so a fork has no way to smuggle code into it.
- A submission PR may only touch `sources.json` and `mods/<id>.json`.
- What it enforces: the new source must be the PR author's own repository (maintainers listed in `MAINTAINERS`
  are exempt), `sources.json` may only grow, a record's `source` must be listed and belong to the author, the
  source repository must still be reachable, and the branch must be `register/**` or `release/**`.
- The comparison uses **merge-base (three-way) semantics**, not a literal diff: authors' branches are often many
  commits behind `main`, and a literal diff would blame this PR for sources that `main` itself added or removed.
- If the merge fails because `sources.json` conflicts (it is one shared list, so two simultaneous submissions
  will clash), the change is **replayed on top of the current `main`** — the union of `sources.json` plus this
  PR's records — and the PR is closed with an explanatory comment. Forks cannot be written to, so replaying is
  what keeps the flow unattended.
- Whatever happens, the bot leaves exactly **one** sticky bilingual comment on the PR
  (marker `<!-- auto-merge-submissions -->`) saying what it listed, or why it refused.

Kill switch: **Settings → Secrets and variables → Actions → Variables**, add `AUTO_MERGE_SUBMISSIONS=off` →
validate and comment only, never merge (back to the manual flow).
Manual re-run: **Actions → auto-merge-submissions → Run workflow** (fill in the PR number; `dry_run=true`
validates without merging).

Content-level validity (`sha256`, key binding, first-come-first-served `id`, …) is still enforced by
`build-index.mjs`: bad entries are skipped and listed in the log, they never go live.

### Re-submitting a rejected / delisted mod

An author who fixes a **rejected** or **delisted** mod and pushes again is not silently stuck:
re-registering the source (or publishing a new version) puts it back in front of the maintainer as a
**re-submission**, and the review console (`mod.5318.cm` → `重新提交` filter) shows the new version next to
the previous verdict and reason.

- `reject` + the source is registered in `sources.json` again → status `重新提交` (re-review), the
  previous reason is shown, the new submission is **not** published until it is reviewed.
- `delist` + the author's manifest version is newer than the indexed one → same re-review state.
- Unattended mode auto-approves a re-submission only when the previous reason is something the automatic
  checks can verify again (manifest completeness, ZIP location, category, `id` uniqueness, key binding,
  unreachable repo). Reasons only a human can judge (e.g. *repo does not belong to the author*, plagiarism,
  malicious code) always wait for the maintainer.
- **`delete` removes the mod completely.** The maintainer console drops the source from `sources.json`
  and clears the mod's `moderation.json` entries — **no blacklist is kept**. If the author wants the mod
  listed again, they publish it from the launcher again and it goes through as a brand-new submission.

### Duplicate submissions and submission bursts

Author-side network retries can open the same submission twice, and a busy hour can bring many authors
at once. Both are handled without the maintainer doing anything:

- **Duplicate PRs are closed automatically.** If a PR adds no new source and every `mods/*.json` it
  carries is byte-identical to `main`, it is treated as a duplicate: the workflow comments, closes the
  PR, and does **not** merge or re-trigger the index rebuild.
- **`sources.json` is de-duplicated.** `build-index.mjs` normalizes the list on every build — trims
  entries, drops malformed ones, and removes case-insensitive duplicates (first occurrence wins,
  order preserved). If anything changed, the same workflow commits the normalized file, so retries can
  never leave phantom duplicates behind.
- **Index rebuilds are serialized.** `build-index.yml` uses `concurrency: build-index`, so a burst of
  submissions queues up instead of racing over `docs/mod-index.json`.
- **Per-author flood gate.** When a non-maintainer account has more than `MAX_OPEN_PER_AUTHOR` open PRs
  at once (default 10, `0` disables), that PR pauses auto-merge for manual review. Set it under
  Settings → Secrets and variables → Actions → Variables.
- **Kill switch.** `AUTO_MERGE_SUBMISSIONS=off` degrades auto-merge to "validate + comment only".

None of these paths lose data: blocked and duplicate PRs stay in the GitHub PR list, and every
moderation decision stays reversible from the console.

### Listing checklist (PR review)

- [ ] the repository added to `sources.json` is the **author's own** (not somebody else's, re-registered as theirs)
- [ ] the repository root contains `evejs-mod.json` with:
      `id` / `displayName` / `version` / `author{id,name,keyId,publicKey}` /
      `sizeBytes` / `sha256` (64 hex chars) / `downloadUrls[]` (at least one `https://` direct link)
      — for a package over 2 GiB use `downloadParts.parts[]` instead (see below)
- [ ] the ZIP lives in the author's own GitHub Releases (this index repository stores **no binaries**)
- [ ] the category uses one of the fixed values: `玩法` / `经济` / `AI` / `画面` / `工具`

CI automatically enforces three **ownership rules** (entries that fail are skipped and listed in the log):

1. **`id` is globally unique, first come first served** — only the first repository in `sources.json` that registered an `id` can update it;
2. **`author.id` <-> public key binding** — the first `keyId` used for an `author.id` is pinned; swapping keys later is rejected (prevents impersonation);
3. **Source is visible** — every index entry records `source` (owner/repo) and the launcher displays it.

### How to fill download URLs (important for reachability in China)

`downloadUrls[]` in `evejs-mod.json` is tried **in ascending `priority` order**; the recommended ordering is:

```jsonc
"downloadUrls": [
  // 1) jsDelivr CDN — much more reachable than raw; single file <= 20MB
  { "mirror": "jsdelivr",   "url": "https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/<id>-<version>.zip", "priority": 1 },
  // 2) GitHub raw — most up to date, but often unreachable
  { "mirror": "github-raw", "url": "https://raw.githubusercontent.com/<owner>/<repo>/main/<id>-<version>.zip", "priority": 2 },
  // 3) github.com/raw — fallback
  { "mirror": "github",     "url": "https://github.com/<owner>/<repo>/raw/main/<id>-<version>.zip", "priority": 3 }
]
```

**Packages larger than 2 GiB (split uploads).** GitHub rejects any single release asset of 2 GiB or
more, so a bigger mod is split by the launcher into ~1.9 GB parts, each uploaded as its own asset.
`evejs-mod.json` (and the version record) then carries a part list **instead of** `downloadUrls`:

```jsonc
"downloadParts": {
  "total": 3,
  "parts": [
    { "url": "https://github.com/<owner>/<repo>/releases/download/v<version>/<id>-<version>.zip.001", "sizeBytes": 1900000000, "sha256": "<64 hex>", "mirror": "github" },
    { "url": ".../<id>-<version>.zip.002", "sizeBytes": 1900000000, "sha256": "<64 hex>", "mirror": "github" },
    { "url": ".../<id>-<version>.zip.003", "sizeBytes": 1200000000, "sha256": "<64 hex>", "mirror": "github" }
  ]
}
```

The launcher downloads the parts in order, verifies each one, joins them into the whole ZIP and
verifies `sha256` again. The checklist above still applies - the only difference is where the bytes live.

Warning: jsDelivr caches **branch references** for up to ~12 hours, so a version you just pushed may still serve the
old file for a while. Putting the version in the file name (`<id>-<version>.zip`) avoids this — a new version is a new
file name and cannot hit the stale cache.

### Local / offline build (optional)

`build-index.mjs` normally fetches each repository's `evejs-mod.json` over the network (raw -> jsDelivr -> github).
If your network cannot reach them (or you want to use a listing you just edited but have not pushed yet), override it
with a local file:

```bash
INDEX_LOCAL_LISTINGS="owner/repo=/abs/path/evejs-mod.json" \
INDEX_SIGNING_KEY="$(cat .keys/index.key)" node scripts/build-index.mjs
```

Separate several sources with `;`.

### Maintainer setup (one time)

**1. Generate the signing key pair** (run locally only)

```bash
node scripts/keygen.mjs --out .keys/index
```

It prints two things:

- `.keys/index.key` (private key) -> copy the **entire file content** into Settings -> Secrets and variables -> Actions -> `INDEX_SIGNING_KEY`
- `keyId` + `publicKey` -> paste into `launcher/launcher/src/main/modSigner.ts` under `BUILTIN_PUBKEYS` (the script prints that exact line)

Never commit the private key (`.gitignore` already ignores `.keys/`). Lose it and you can never sign an index the
client accepts again.

**2. Enable GitHub Pages** (recommended: publish `/docs` from `main`)

Repository -> Settings -> Pages -> **Source: Deploy from a branch** -> Branch: **`main`** / **`/docs`** -> Save

> `https://diguo520.github.io/EVEjs-mods/mod-index.json` becomes available immediately (`docs/mod-index.json` is
> already in the repository). Each CI run commits the new index back into `docs/` on `main` and Pages republishes
> automatically — no `gh-pages` branch involved.

**3. Run the workflow once**

Repository -> Actions -> `build-index` -> **Run workflow**. Afterwards open:

```
https://diguo520.github.io/EVEjs-mods/mod-index.json
```

(The first generation may take 1-2 minutes.)

**Optional fallback when no secret is configured**: build locally and commit

```bash
cd <this repo>
INDEX_SIGNING_KEY="$(cat .keys/index.key)" node scripts/build-index.mjs
git add docs/mod-index.json && git commit -m "chore(index): refresh" && git push
```

### Local debugging

```bash
# generate a throwaway index with a test key (nothing is pushed)
node scripts/keygen.mjs --out .keys/test
INDEX_SIGNING_KEY="$(cat .keys/test.key)" node scripts/build-index.mjs
```

You can then feed the generated `docs/mod-index.json` to the launcher's verification logic
(`src/main/modSigner.ts` -> `verifyIndexSignature`).

### Maintainer moderation: approve / reject / delist

#### The easy way: double-click `审核台.bat` (review console)

1. Open the `EVEjs-mods` folder and double-click **`审核台.bat`** (needs Node.js) — your browser opens `http://127.0.0.1:8790`.
2. In the page:
   - **Quick actions** — paste an author's `owner/repo` and hit **收录通过 / accept**: that is the same as merging their listing PR, no PR needed.
     If you merged a PR on GitHub instead, click **重新构建签名索引并推送 / rebuild and push** once so it takes effect immediately.
   - **Market mods** — every row has **下架 / delist**, **恢复上架 / restore** and **拒绝收录 / reject**. Delist and reject ask for a reason, and the author sees it in the launcher.
3. Every click does three things for you: writes `moderation.json` → rebuilds and signs the index with `.keys/index.key` → `git commit` + `git push`.
4. Close the window to stop the console. (No GitHub token needed — it uses your local git credentials.)

> The CLI below is the exact equivalent if you prefer the terminal.

Every moderation result lives in **`moderation.json`**, written for you by `scripts/moderate.mjs`;
`build-index.mjs` reads it when generating the index.

```bash
node scripts/moderate.mjs list                       # reviewer dashboard
node scripts/moderate.mjs approve <owner/repo>       # accept a listing (writes sources.json)
node scripts/moderate.mjs reject <id|owner/repo> --zh "reason" --en "reason"
node scripts/moderate.mjs delist <id|owner/repo> --zh "reason" --en "reason"
node scripts/moderate.mjs restore <id|owner/repo>    # undo a moderation result
node scripts/moderate.mjs pr-text <id|owner/repo>    # bilingual reply you can paste into the PR
```

Rebuild and push so clients see the change:

```bash
node scripts/build-index.mjs
git add -A && git commit -m "chore(index): moderation" && git push
```

| action | in the index | launcher: Mod market | launcher: My mods (author) |
| --- | --- | --- | --- |
| (none) | normal entry | listed, installable | Listed |
| `delist` | entry kept with `delisted:true` + `delistReason` | **not listed**, install/update blocked | red "Delisted" badge + reason |
| `reject` | entry dropped, recorded in the `moderation` map | not listed | red "Not accepted" badge + reason |

> Moderation acts on the **index layer**: the ZIP always stays in the author's own repository — you only decide
> whether it is visible in the market.

---

## 中文

这个仓库**只做三件事**：

1. 用 `sources.json` 登记"哪些作者仓库要收录"；
2. 用 CI 定时抓这些仓库的 `evejs-mod.json`，合并成一份 **`mod-index.json`**；
3. 用仓库 Secret 里的私钥给它**签名**，发布到 GitHub Pages。

启动器读的就是这一个文件：

```
https://diguo520.github.io/EVEjs-mods/mod-index.json
```

> **不需要服务器**：索引是静态 JSON（GitHub Pages），模组 ZIP 由作者自己的仓库托管，
> 完整性靠索引里的 sha256，而索引本身由维护者私钥签名 —— 客户端**先验签，再信任里面的任何地址与哈希**。

### 目录结构

```
EVEjs-mods/
  sources.json                  收录了哪些作者仓库
  author-keys.json              author.id ↔ 公钥 绑定记录（CI 自动维护，防借名）
  moderation.json               维护者审核结果（拒绝收录 / 下架 + 原因）
  scripts/
    keygen.mjs                 维护者生成签名密钥对（只跑一次）
    build-index.mjs            抓取 → 校验 → 合并 → 签名 → 输出 docs/mod-index.json
    moderate.mjs               审核 CLI：list / approve / reject / delist / restore / pr-text
  .github/workflows/
    build-index.yml            每 6 小时 + 手动触发 + push 触发
    auto-merge-submissions.yml 自动校验投稿 PR 并无人值守合并
    mirror-ratings.yml         每小时把已签名的市场快照抄进 docs/ratings/
  docs/                        CI 产物，由 GitHub Pages 从 main 分支的 /docs 发布
    mod-index.json
    ratings/                   市场快照的备门镜像（ratings.json / sponsors.json / reviews/）
```

### 作者怎么上架自己的模组（每次发布一条 PR，在这里审）

1. 在自己仓库里放模组源码，用**启动器**的「提交模组 → 发布到我的仓库」：
   启动器会帮他写好 `evejs-mod.json` 并建 Release、上传 ZIP；
2. 用启动器的「提交审核」往本仓库提一条 PR：
   - 首次发布：`sources.json`（登记 `<owner>/<repo>`）**和** `mods/<id>.json`（本次版本记录）；
   - 之后每次发新版：只更新 `mods/<id>.json`（同一个 `release/<id>` 分支，
     所以是**刷新同一条 PR**，不会一版一条堆在这里）；
3. **不需要有人守在电脑前**：`.github/workflows/auto-merge-submissions.yml` 会照下面的收录规范自动校验并合并
   （见[无人值守收录](#无人值守收录自动合并不需要维护者在线)），不合格就留一条评论说明原因；
   维护者当然也可以随时人工看一遍再合。**只有通过校验的记录才会上线**：
   `build-index.mjs` 把已合并的 `mods/<id>.json` 当作该来源的权威版本，
   所以市场是**跟着 PR 合并**换版本的（`mods/**` 也在 workflow 的 paths 里，合并即立刻重建；
   6 小时的定时任务只当兜底）。

### 无人值守收录（自动合并，不需要维护者在线）

`.github/workflows/auto-merge-submissions.yml` 把「必须有人坐在电脑前点合并」这一步去掉了：
它按下面的收录规范校验每一条投稿 PR，自己决定合不合并，合完立刻点名触发 `build-index`
（它用 `GITHUB_TOKEN` 推的那次提交不会触发其它 workflow —— 这是 GitHub 防递归的规则，所以必须点名）。

- 触发入口：`pull_request_target`（opened / synchronize / reopened / ready_for_review），
  外加 `repository_dispatch`（事件 `auto-merge-check`，用 `client_payload.pr` 指定 PR）与手动 `workflow_dispatch`。
- 结构上就安全：workflow 永远取自 base 分支，**绝不 checkout / 执行 PR 里的代码**，只用 API 读 PR 的**数据**，
  所以从 fork 提上来的提交没有任何机会把代码跑进这个流程里。
- 投稿 PR 只允许改 `sources.json` 与 `mods/<id>.json` 两类文件（改 workflow / scripts 的一律拦掉，
  否则「自动合并」就等于一个任意代码执行入口）。
- 自动拦下的情况：新增来源不是 PR 作者自己的仓库（`MAINTAINERS` 里的维护者例外）、`sources.json` 里删掉了已有来源、
  记录的 `source` 不在名单里或不属于作者、来源仓库已经访问不到、分支名不是 `register/**` 或 `release/**`。
- 判定用 **merge-base 的三方合并语义**，不是字面 diff：作者分支常常落后 `main` 很多，
  字面比较会把 `main` 早就加过 / 早就删过的来源误算成这条 PR 的动作，从而误拦。
- 如果因为 `sources.json` 撞车而合不上（这份清单是所有人共用的，两条投稿同时进来必然冲突），
  会**按 main 现状重放**：用 main 现有清单并上这条 PR 的新增来源与版本记录，直接生成一次提交推到 main，
  然后把 PR 关掉并说明原因 —— fork 分支我们没有写权限（`update-branch` 会 403），重放才能保住「无人值守」。
- 不管结果如何，机器人都只在 PR 上留**一条**中英双语评论（标记 `<!-- auto-merge-submissions -->`），
  说明收录了什么、或者为什么没收录 —— 失败不会静默。

总开关：仓库 **Settings → Secrets and variables → Actions → Variables** 里加 `AUTO_MERGE_SUBMISSIONS=off`
→ 只校验 + 留言，不自动合并（回到人工流程）。
手动补跑：**Actions → auto-merge-submissions → Run workflow**（填 PR 编号；`dry_run=true` 只校验不合并）。

### 作者修正后重新提交（未通过 / 已下架）

作者修好一个**未通过**或**已下架**的模组再推一次，不会永远卡住：他重新登记来源（或发布新版本）后，
条目会作为**重新提交**回到维护者面前，审核台（`mod.5318.cm` → 「重新提交」筛选）会把新版本
连同**上次结论与理由**一起列出来。

- `reject` 之后来源又出现在 `sources.json` 里 → 状态变成「重新提交」，复审通过前**不会**上架。
- `delist` 之后作者仓库里的清单版本比索引里的新 → 同样进入「重新提交」复审。
- 无人值守只在「历史理由能被自动检查重新复核」时自动复审（清单完整性、包体位置、分类、`id` 唯一、
  密钥绑定、仓库失联）。只能靠人判断的理由（例如**仓库不属于作者**、抄袭、恶意代码）一律等维护者，
  否则重新提交就等于绕过拒绝。
- **`delete` 是彻底移除**：审核台会把来源从 `sources.json` 里删掉，并清掉它在 `moderation.json`
  里的记录 —— **不留黑名单**。作者想重新上架，用启动器重新发布提交即可，那会走一次**全新的收录**。

内容层面的合法性（`sha256`、公钥绑定、`id` 先到先得……）仍然由 `build-index.mjs` 把关：
不合格的条目会被跳过并在日志里列出，不会上架。

### 重复提交 / 集中大量提交

作者端网络重试可能把同一次投稿开出两条 PR，热门时段也可能一次涌进来很多作者。这两种情况都**不需要**
维护者盯着：

- **重复 PR 自动关闭**：一条 PR 如果没有新增来源，且它带的每个 `mods/*.json` 都与 `main` 上的内容
  逐字节一致，就按「重复提交」处理 —— 工作流留言并关闭这条 PR，**不合并、也不再重复触发一次索引重建**。
- **`sources.json` 自动去重**：`build-index.mjs` 每次构建都会归一化这份清单 —— 去空白、丢掉格式非法的
  条目、按**不区分大小写**去重（保留第一次出现的写法与顺序）。内容真的变了才由同一个工作流提交回去，
  所以重试不会在清单里留下重复项。
- **索引重建串行化**：`build-index.yml` 用 `concurrency: build-index`，一次涌进来多少提交都只是排队，
  不会出现两个重建同时改 `docs/mod-index.json` 互相踩。
- **单作者洪泛闸**：非维护者账号同时挂着的 open PR 超过 `MAX_OPEN_PER_AUTHOR`（默认 10，填 0 关闭）时，
  这条 PR 暂停自动合并、转人工看一眼。阈值在 Settings → Secrets and variables → Actions → Variables 里改。
- **总开关**：`AUTO_MERGE_SUBMISSIONS=off` 会把自动合并退化成「只校验 + 留言」。

这几条路径都不会丢数据：被拦下、或被判定为重复的 PR 都还留在 GitHub 的 PR 列表里，
审核结论也随时可以从审核台回退。

### 收录规范（PR 检查清单）

- [ ] `sources.json` 里新增的是**作者自己的仓库**（不是把别人的仓库登记成自己的）
- [ ] 该仓库根目录有 `evejs-mod.json`，且包含：
      `id` / `displayName` / `version` / `author{id,name,keyId,publicKey}` /
      `sizeBytes` / `sha256`(64 位 hex) / `downloadUrls[]`（至少一个 `https://` 直链）
      —— 超过 2 GiB 的包改用 `downloadParts.parts[]`（见下）
- [ ] ZIP 放在作者自己的 GitHub Releases（本索引仓库**不存二进制**）
- [ ] 分类使用统一取值：`玩法` / `经济` / `AI` / `画面` / `工具`

CI 会自动执行三条**归属硬规则**（不合格的条目会被跳过并在日志里列出）：

1. **`id` 全局唯一、先到先得** —— 同一个 `id` 只有 `sources.json` 里第一次出现的仓库能更新它；
2. **`author.id` ↔ 公钥绑定** —— 同一个 `author.id` 第一次用的 `keyId` 固定，之后换钥匙会被拒绝（防借名）；
3. **来源可见** —— 每条索引都会写 `source`（owner/repo），启动器会展示来源。

### 下载地址怎么填（重要：国内可达性）

`evejs-mod.json` 的 `downloadUrls[]` **按 priority 从小到大尝试**，建议这样排：

```jsonc
"downloadUrls": [
  // 1) jsDelivr CDN —— 国内可达性明显好过 raw；单文件 ≤20MB
  { "mirror": "jsdelivr",   "url": "https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/<id>-<version>.zip", "priority": 1 },
  // 2) GitHub raw —— 最及时，但国内经常连不上
  { "mirror": "github-raw", "url": "https://raw.githubusercontent.com/<owner>/<repo>/main/<id>-<version>.zip", "priority": 2 },
  // 3) github.com/raw —— 兜底
  { "mirror": "github",     "url": "https://github.com/<owner>/<repo>/raw/main/<id>-<version>.zip", "priority": 3 }
]
```

**超过 2 GiB 的包（切片上传）。** GitHub 不接受 2 GiB 及以上的单个发布资产，所以更大的模组由启动器
切成约 1.9 GB 一片、各传一个资产；这时 `evejs-mod.json`（以及版本记录）里带的是**分片清单**，
没有整包的 `downloadUrls`：

```jsonc
"downloadParts": {
  "total": 3,
  "parts": [
    { "url": "https://github.com/<owner>/<repo>/releases/download/v<version>/<id>-<version>.zip.001", "sizeBytes": 1900000000, "sha256": "<64 位 hex>", "mirror": "github" },
    { "url": "…/<id>-<version>.zip.002", "sizeBytes": 1900000000, "sha256": "<64 位 hex>", "mirror": "github" },
    { "url": "…/<id>-<version>.zip.003", "sizeBytes": 1200000000, "sha256": "<64 位 hex>", "mirror": "github" }
  ]
}
```

启动器按顺序逐片下载、逐片校验，再拼成整包并复核 `sha256`。上面的收录规范依然适用，
区别只是字节放在分片里 —— `sizeBytes` 与 `sha256` 仍然指**整包**。

⚠️ 注意 **jsDelivr 对「分支引用」的内容缓存最长约 12 小时**：刚提交的新版本可能短期内还拿到旧文件。
版本号写在文件名里（`<id>-<version>.zip`）可以规避这个问题 —— 新版本是新文件名，不会命中旧缓存。

### 本地 / 离线构建（可选）

`build-index.mjs` 默认联网抓各仓库的 `evejs-mod.json`（raw → jsDelivr → github 依次尝试）。
如果你本地网络抓不到（或想用刚改完还没推上去的清单），可以用本地文件覆盖：

```bash
INDEX_LOCAL_LISTINGS="owner/repo=/abs/path/evejs-mod.json" \
INDEX_SIGNING_KEY="$(cat .keys/index.key)" node scripts/build-index.mjs
```

多个来源用 `;` 分隔。

### 维护者操作（第一次）

**① 生成签名密钥对**（只在本机跑）

```bash
node scripts/keygen.mjs --out .keys/index
```

会打印两样东西：

- `.keys/index.key`（私钥）→ 复制**整个文件内容** → 仓库 Settings → Secrets and variables → Actions → `INDEX_SIGNING_KEY`
- `keyId` + `publicKey` → 贴进启动器 `launcher/launcher/src/main/modSigner.ts` 的 `BUILTIN_PUBKEYS`（脚本会直接打印那一行）

⚠️ 私钥**永远不要**提交（`.gitignore` 已忽略 `.keys/`）。丢了私钥就再也签不出被客户端认可的索引。

**② 开 GitHub Pages**（推荐：直接发布 `main` 分支的 `/docs`）

仓库 → Settings → Pages → **Source: Deploy from a branch** → Branch: **`main`** / **`/docs`** → Save

> 这样 `https://diguo520.github.io/EVEjs-mods/mod-index.json` 立刻可用（`docs/mod-index.json` 已经在仓库里）。
> CI 每次跑完会把新索引**提交回 main 的 `docs/`**，Pages 自动重新发布，不需要 `gh-pages` 分支。

**③ 跑一次 CI**

仓库 → Actions → `build-index` → **Run workflow** → 跑完访问：

```
https://diguo520.github.io/EVEjs-mods/mod-index.json
```

（首次生效可能要等 1~2 分钟）

**（可选）没配 secret 时的兜底**：本机手动跑一次再提交

```bash
cd <这个仓库>
INDEX_SIGNING_KEY="$(cat .keys/index.key)" node scripts/build-index.mjs
git add docs/mod-index.json && git commit -m "chore(index): refresh" && git push
```

### 本地调试

```bash
# 用测试密钥在本地生成一份索引（不推仓库）
node scripts/keygen.mjs --out .keys/test
INDEX_SIGNING_KEY="$(cat .keys/test.key)" node scripts/build-index.mjs
```

生成的 `docs/mod-index.json` 可以拿去对启动器的验签逻辑（`src/main/modSigner.ts` 的 `verifyIndexSignature`）跑一遍。

### 维护者审核：收录 / 拒绝 / 下架

#### 最简单的方式：双击 `审核台.bat`

1. 打开 `EVEjs-mods` 文件夹，**双击 `审核台.bat`**（需要 Node.js）—— 浏览器会自动打开 `http://127.0.0.1:8790`。
2. 页面里：
   - **快捷操作**：把作者的 `owner/repo` 填进去点 **收录通过**，等价于合并他的收录 PR（连 PR 都不用开）；
     如果你是在 GitHub 网页上 Merge 的 PR，回来点一次 **重新构建签名索引并推送** 就立刻生效。
   - **市场里的模组**：每行有 **下架 / 恢复上架 / 拒绝收录**；下架与拒绝会让你填原因，作者在启动器里就能看到。
3. 每次点击它自动做三件事：写 `moderation.json` → 用 `.keys/index.key` 重建并签名索引 → `git commit` + `git push`。
4. 关掉那个黑窗口就停止（不需要 GitHub 令牌，用的是你本机已保存的 git 凭据）。

> 下面的命令行是等价做法，喜欢敲命令时用。

所有审核结果都写在 **`moderation.json`**，由 `scripts/moderate.mjs` 帮你写；`build-index.mjs` 读它来出索引。

```bash
node scripts/moderate.mjs list                       # 看现在收了谁、有没有被拒/下架
node scripts/moderate.mjs approve <owner/repo>       # 审核通过（写进 sources.json）
node scripts/moderate.mjs reject <id|owner/repo> --zh "原因" --en "reason"
node scripts/moderate.mjs delist <id|owner/repo> --zh "原因" --en "reason"
node scripts/moderate.mjs restore <id|owner/repo>    # 撤销审核结果（重新上架 / 恢复收录）
node scripts/moderate.mjs pr-text <id|owner/repo>    # 生成可直接贴到 PR 的中英双语文案
```

改完必须重跑构建 + 推送，客户端才会看到：

```bash
node scripts/build-index.mjs
git add -A && git commit -m "chore(index): moderation" && git push
```

三种状态的效果：

| action | 索引里 | 启动器「模组市场」 | 启动器「我创建的」（作者） |
| --- | --- | --- | --- |
| 不填（正常） | 正常条目 | 正常展示、可安装 | 已上架 |
| `delist` | 条目保留，带 `delisted: true` + `delistReason` | **不再列出**，也不能安装/更新 | 红标「已下架」+ 原因 |
| `reject` | 条目被丢弃，只留在 `moderation` 表 | 不出现 | 红标「已拒绝收录」+ 原因 |

> 审核是**索引层**的动作：ZIP 始终在作者自己的仓库里，你只决定它在市场里可见还是不可见。

> ⚠️ **Windows 上跑构建请加 `--use-system-ca`**：
> `node --use-system-ca scripts/build-index.mjs`
> 不加的话，Node 不信任系统证书，`raw.githubusercontent.com` 与 `api.github.com` 会连接失败，
> 构建只能退回 **jsDelivr 的 `@main` 分支缓存**（最长 12 小时），于是索引里可能留下**旧版本**的下载地址 ——
> 作者发了新版、删了旧 Release 之后，用户安装就会 404。审核台的「重新构建签名索引并推送」已经自动带上这个参数。
