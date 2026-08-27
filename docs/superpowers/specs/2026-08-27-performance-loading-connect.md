# 性能、加载与连接速度优化方案

**Date:** 2026-08-27  
**Status:** Proposal  
**Scope:** VS Code / Cursor 扩展 `at-jumpserver-terminal`（当前 0.1.9）  
**Method:** 三路代码扫描（扩展加载 / 连接瀑布 / 运行期吞吐），对照已落地的 `docs/superpowers/plans/2026-08-20-jumpserver-connect-optimize.md`。

不改 HMAC、不持久化 Bearer/Cookie、不默认打开 `token_reusable`。本文件只定方向与落地顺序；实施时按批次拆 PR。

---

## 1. 结论

0.1.9 已经把 2026-08-20 连接加速计划的 7 项全部落地：堡垒客户端池、Bearer / KoKo warmup in-flight、资产详情与 smart endpoint 缓存、有 `sessionid` 时 WebSocket 优先、SSH 连接只绑定 Files 视图。热连接（同堡垒第二次）已经接近「一次 connection-token + 一次 WS 握手」。

剩下的体感问题不在那条计划里，而在三类路径：

| 路径 | 现状 | 用户感知 |
|---|---|---|
| 活动栏 / 资产树 | 每次展开都对最多 1 万条缓存做 zod 全量解析 | 资产多时点开树卡顿 |
| 冷启动连接 | REST 无 keep-alive；warmup 仍串行 3–7 个请求；分页有 `next` 时并发分支走不到 | 首次连接、大库存刷新偏慢 |
| 终端 / SFTP 运行期 | 默认 semantic highlight 最坏 O(m²)；zebra 每帧改 classList；上传整文件单帧 | `cat` 掉帧；大文件上传可能 OOM |

建议先做「树缓存 + 高亮/zebra + detail in-flight」三条低风险改动，再动传输层与 SFTP 协议。

---

## 2. 已落地（不要再做一遍）

对照 2026-08-20 计划，代码与测试均已对齐（`bf3a9e2`）：

- `JumpServerClient.ensureAuthToken` / `warmupKokoConnectPage` 的 in-flight
- `getAssetDetail` / `getSmartEndpoint` 命中缓存
- `openKokoSocket`：有 `sessionid` 先握手，失败再 HTML warmup
- `JumpServerSftpManager.openAsset` 只 bind，`pending` 占位，Refresh 才建 SFTP
- 终端输出 8 ms / 64 KB 聚合、`SlidingByteWindow`、写入背压、空闲断开不轮询、MCP 每终端串行队列

xterm 只打进 webview 包（约 300 KB），扩展宿主 377 KB 不含 `@xterm/*` 与 `@modelcontextprotocol/sdk`。`activate()` 同步返回，远端资产不在激活时拉取。

---

## 3. 当前瀑布（便于对照改动）

### 3.1 冷启动 SSH（全串行）

```
connect → createClient
  getAssetDetail（内部可能 JSON+form 两次登录）
  createConnectionToken
  getSmartEndpoint
  warmup: GET /koko/connect → 登录页 → POST → 最多 5 次 302 → GET profile → 再 GET connect
  WebSocket 握手（可能是另一 host）
```

热连接：detail / endpoint 命中 + 新 token + WS。SFTP 首次 Refresh 同理，只多一次 token + WS。MySQL / Redis 与 SSH 无额外网络步骤。

单击资产会**同时**触发 `onDidChangeSelection` 预取和 `jumpserverManager.connect`。详情缓存只在完成后写入，两条路径会打两次同一 REST。

### 3.2 资产刷新

```
ensureOrgContext → listAccessibleOrgs（即使 orgId 已保存）
listAssetNodes（all-with-assets/tree，最重）
listAllAssets（有 DRF next 时逐页串行；ASSET_PAGE_CONCURRENCY=4 几乎走不到）
```

### 3.3 激活

`onStartupFinished` 每个窗口都会：读两份约 400 KB 的 `hub.js` 做 sha256、起 Bridge HTTP、写 MCP 配置。未配置堡垒的用户也全额执行。

---

## 4. 方案（按优先级）

严重度：P0 默认路径上可感知卡顿或 OOM；P1 每次启动/刷新/保存都付的固定税；P2 锦上添花。

### 批次 A — 低风险、立刻体感（建议第一批 PR）

#### A1. 资产树缓存 memoize（P0，加载 + 运行期交叉）

**现状:** `JumpServerTreeProvider.getChildren` 每次展开都调用 `listCachedAssets` / `listCachedAssetNodes`；二者对 `globalState` 全量逐行 `zod.parse`（上限 10_000，且带嵌套 `raw`）。`migrateIfNeeded` 每次读都跑一遍。MCP `jumpserver_list_assets` 同样全量解析。

**改法:**

1. `JumpServerConfigManager` 内缓存已解析数组，仅在 save / delete 时失效。
2. `migrateIfNeeded` 用实例级一次性 Promise。
3. 树侧按 `bastionId` 建 `{assets, nodes, pathIndex}`，`refresh()` 清索引。
4. 后续：`raw` 改为白名单或独立 key（见 C3），进一步缩小 globalState。

**风险:** 所有写入口必须失效缓存；写都在本类内，收敛容易。

#### A2. semantic highlight 降复杂度 + 大块旁路（P0）

**现状:** `semanticHighlightText` 默认开启。每块最多 64 KB、7 条全局正则；`overlapsExistingMatch` 线性扫描。数字规则会让纯文本日志/CSV 产生数千 match，比较次数达千万级。含 ANSI 的块反而整块跳过，惩罚落在最需要吞吐的纯文本上。

**改法:**

1. 收集后按 start 排序再单遍去重（O(m log m)）。
2. 单块 >16 KB 或 match >500 直接旁路。
3. 评估删掉或降权数字规则，或合并为一条 alternation。

**风险:** 规则优先级需与现有测试对齐。

#### A3. zebra 改为纯 CSS（P0）

**现状:** DOM renderer + 每次 `onWriteParsed` 后 `querySelectorAll` 并对每行 `classList` 增删，触发整屏 style recalc。

**改法:** `.xterm-rows > div:nth-child(even)` 两条 CSS，删除 zebra JS 刷新循环。WebGL addon 另案评估（canvas 下 CSS zebra 失效）。

**风险:** 视口行奇偶与当前实现一致，目测即可。

#### A4. `getAssetDetail` in-flight 去重（P1，连接）

**现状:** 单击同时 prefetch + connect，缓存未写入前打两次详情接口。

**改法:** 仿 `authInflight`，`Map<assetId, Promise<detail>>`；401 时丢掉失败 Promise，不要缓存拒绝结果。预选取消键盘连移时的请求风暴：300–500 ms debounce，且仅当该堡垒已有池内 client 时才预取（避免为预取而登录）。

---

### 批次 B — 连接与刷新（第二批 PR）

#### B1. 有 `count` 时走并发 offset 分页（P1）

**现状:** `listAllAssets` 只要 `next` 是字符串就串行跟随。真实 DRF 同时带 `count` 和 `next`，`ASSET_PAGE_CONCURRENCY = 4` 的分支基本是死代码。现有并发测试用的是无 `next` 的 fixture。

**改法:** `count` 已知时优先并发 offset；`next` 链只留给无 count 的兜底。`dedupeAssetsById` 与 `pageSignature` 保留。

**影响:** 2000 资产约 10 页，刷新从全串行 RTT 降为约 1/4。

#### B2. 每 client 一个 keep-alive `https.Agent`（P1）

**现状:** `restTransport.ts` 未设 `agent`。Node 默认 keep-alive 空闲约 5 s，预取与点击之间通常已断，瀑布里每个 REST 重新 TCP+TLS。

**改法:** `JumpServerClient` 持有 `https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 8 })`；`pool.drop` / `dropAll` 时 `destroy()`。`verifyTls: false` 的 socket 不得跨 client 复用。

**风险:** WS 在可能不同的 `endpoint.host` 上，无法复用，属固有成本。

#### B3. 刷新时跳过组织列举；节点树与资产并行（P2）

**现状:** 即使 `bastion.orgId` 有效，每次 refresh 仍 `listAccessibleOrgs`（403 还会换头再拉一轮），然后串行 `listAssetNodes` 再 `listAllAssets`。

**改法:**

1. 已保存 orgId 则直接用；后续 403 再回落 QuickPick。
2. 节点树与资产列表并行，但 **tree 端点只拉一次**（今天传 `treePaths` 就是为了防双拉）。

#### B4. 精简冷启动 warmup（P1，分两步）

**第一步（低风险）:** 登录 POST 已拿到 `sessionid` 后，去掉随后的 profile GET 与第二次 `/koko/connect` 验证 GET；WS 失败本就会回落 warmup。

**第二步（高风险，单独 PR + 开关）:** 把 Django 表单登录从 token 之后拆出，用固定 `/core/auth/login/?next=/koko/connect/` 与 REST 链并行。不依赖真实 token。

**风险:** 部分反代/MFA 部署依赖重定向跟随；并行预热会增加 core 审计日志。默认不要开第二步。

#### B5. 记住 Bearer 成功的编码（P2）

JSON 失败再 form 的双 POST 每个 client 生命周期只一次。记住上次成功的 content-type 即可省 1 RTT。

---

### 批次 C — 启动与包体（第三批 PR）

#### C1. Hub sync 短路 + 未配置跳过（P1）

**现状:** 每次激活读 `dist/hub.js` 与 `~/.at-series/hub.js`（各约 397 KB）做 sha256 + 文件锁，即使版本一致。未配置用户同样起 Bridge。

**改法:**

1. 比较 `hub-version.json` 的 version（构建时写入 sha256 更好），相等则跳过读包/hash/锁。
2. `listBastions()` 为空则不 sync / 不起 bridge；配置保存成功后再启动。
3. 可选：idle 后再跑，避免和窗口启动抢 I/O。MCP 心跳允许 ≤30 s，延迟数秒可接受。

#### C2. MCP 运行时拆第二入口惰性加载（P1）

**现状:** 单文件 CJS；`@at-series/mcp-hub` 不能 tree-shake（约 259 KB + `semver` 65 KB）进 `extension.js`（377 KB）。`ws` 在模块加载期就解析。

**改法:** `dist/mcpRuntime.js` + `require(context.asAbsolutePath(...))` 在 C1 的延迟点加载。上游 mcp-hub 提供 ESM / 子路径导出后再 tree-shake。

#### C3. 依赖与激活事件清理（P2）

- 删除未引用的 `@modelcontextprotocol/sdk`（metafile 确认未进包）。
- 去掉冗余的 `onView:*`（`onStartupFinished` 已覆盖；VS Code 对 contributed views 也会隐式激活）。
- 评估把打进 bundle 的运行时依赖标为 `devDependencies`（`vsce package --no-dependencies`）。

#### C4. Bridge 心跳少写盘（P2）

`connectedTargets` 未变时 `utimes` 代替重写 JSON，减少云盘/同步目录抖动。需确认 hub 对 `updatedAt` 的检查方式。

---

### 批次 D — SFTP 与输出通道（第四批 PR，协议相关）

#### D1. 分块上传 + 流式下载（P0 / P1）

**上传:** `uploadBytes` 把整文件 base64 后 `JSON.stringify` 进单帧。500 MB 峰值约 1.8 GB，可 OOM。8 MB 高水位只限并发帧，不限单帧。

**下载:** `pending.chunks` 全量 `Buffer.concat` 再 `writeFile`。

**改法:** 若 KoKo 认 `chunk`/`offSet`，按 4–8 MB 分块 + `sendWhenDrained`；本地用 stream。不支持则加体积上限并提示。下载用 `createWriteStream` sink。顺带把已有的 `TransferProgress` 接上（今日为死代码）。

**风险:** 需探针验证目标 KoKo 版本；失败恢复与顺序要有测试。

#### D2. 编辑链路去掉 N+1 listing / 双下载（P1）

`stat()` 用列父目录模拟，还会改写 `currentPath`。打开编辑 = 两次 listing + 两次全文件下载；每次保存 = 两次 listing + 一次回读比对。

**改法:** `stat` 无副作用；打开时复用已采样内容（≤ maxBytes 则不必二下）；保存校验改为 size/mtime，内容比对仅在 size 可疑时；同目录 listing 1–2 s TTL。

#### D3. SFTP 树刷新去抖（P1）

Tab 切换 → `setActive` 无条件 `activeChanged` → 根 `refresh()` → 所有已展开目录重新 `listDirectory`。增删改也全树刷新。

**改法:** `terminalId`/connected 未变不 fire；变更命令 `refresh(parentItem)`；listing 按 path 失效。

#### D4. 输出改传 `Uint8Array`（P2）

webview `postMessage` 支持结构化克隆。去掉宿主 base64 与 webview `atob` 逐字节还原。保留 base64 分支作旧宿主回退可选。

#### D5. `collectUntil` 增量完成检测（P2）

`markerSeen` 后每 chunk 对整窗 `toString` + 正则。缓存 start 位置，只扫新增尾部。

#### D6. 超大目录截断（P2）

树路径对 KoKo 全量 entries 建 TreeItem；MCP 已有 maxEntries。超过约 2000 追加 “Show more…”。

---

## 5. 明确不做 / 缓做

| 项 | 原因 |
|---|---|
| `token_reusable: true` | 安全与 JumpServer 策略，0.1.9 计划已排除 |
| 磁盘持久化 Bearer / session | 同上 |
| 关掉 `retainContextWhenHidden` | 终端重建会丢滚动缓冲；多终端内存线性增长是已知代价 |
| 默认上 WebGL renderer | 与 zebra/CSS 冲突，需单独评估 GPU 回退 |
| 把 MCP 每终端队列改成并行 | 正确性优先，PTY 交错会写坏会话 |
| 为预取而触发 REST 登录 | 浏览树不应付登录成本（A4 debounce + 仅已有 client） |

---

## 6. 建议落地顺序

| 顺序 | 批次 | 内容 | 为何先做 |
|---|---|---|---|
| 1 | A | 树 memoize、highlight、zebra CSS、detail in-flight | 改动局部，默认路径立刻变快 |
| 2 | B1–B3 | 分页并发、keep-alive、刷新少打 org/树串行 | 刷新与冷连接 RTT |
| 3 | B4 第一步 + B5 | 删 warmup 冗余 GET、记住 auth 编码 | 冷连接，风险可控 |
| 4 | C | hub 短路、惰性 MCP 包、依赖清理 | 每个窗口启动税 |
| 5 | D | SFTP 分块/流式、编辑 N+1、树刷新 | 协议验证成本高，单独探针 |
| 6 | B4 第二步 | warmup 与 REST 并行 | 需开关与 MFA/反代验证 |

每批：先补失败测试，再改代码；连接日志仍禁止打印 token URL、Cookie、密码。

---

## 7. 验收信号（人工）

**树:** 万级缓存下连续展开分组，扩展宿主无连续数百 ms 卡顿；Output 无因预取产生的登录风暴。

**连接:** 同堡垒第二次 SSH：`client reused`、`REST bearer reused`、`KoKo endpoint reused`、`websocket with cached session`，无 `REST bearer login`。首次连接总耗时日志下降（去掉冗余 warmup GET 后更明显）。

**刷新:** 多页 bastion 出现并发 offset 请求（或日志页数/耗时匹配并发）；已保存 org 时不再先拉组织列表。

**终端:** `semanticHighlight` 开着 `cat` 数字密集日志不冻 webview；zebra 仍可见、无每帧 JS。

**SFTP:** 小文件编辑打开/保存不再列两次父目录；大文件上传进程内存不再随文件线性涨到数倍（分块落地后）。

**启动:** 未配置堡垒时不写 MCP hub 包、不起 bridge（C1 落地后）。
