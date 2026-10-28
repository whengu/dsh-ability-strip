# dsh-ability-strip

> **AI 编写声明（如实披露）**：本插件的全部代码与文档由 AI 编写（DeepSeek 的 AI 编程智能体，在 DeepSeek Harness 会话中完成）。人类角色是需求方与评审验收方：提出需求、纠正设计、把关 code review、做最终验收和安装决策；代码本身没有人类手写的行。对 AI 生成代码有顾虑的使用者请知悉后再用。

DeepSeek Harness（dsh）Web GUI 输入框下方的**只读**能力条——挂在输入栏自己的 dock 里，和 persona 条同一排。它回答一个 GUI 默认看不见的问题：*这个会话到底有什么可用？*——用两个互相独立的标记回答：

| 标记 | 数据来源 | 收起时的回答 |
| --- | --- | --- |
| **skill** | `skills/list`（浏览器 Remote） | 本会话可见的可调用 skill 数量 |
| **MCP** | `ctx.tools.schemas()`（本包的宿主半边） | 有工具注册时显示工具总数；否则 显示 连接故障 / 未连接 / 读取失败 |

点击这一行（`role="button"`，就是 skill/MCP 区域本身，没有单独的展开图标）展开**浮动**明细面板（fixed，portal 到 `<body>`，永不推挤页面）：列出每个 skill 的 `/name`、`model+user` / `user-only`、描述和 `whenToUse`；每个**已连接** MCP 服务器的工具数量和工具名称；已配置的 MCP Loader 行单独列出，带各自的 phase；`dsh-mcp-resources` 是否挂载；以及 profile 启用的插件包。刷新和关闭在面板头部；Escape 或点击面板外任意位置关闭。

## MCP 的"已连接"判断是真实的，且会自我刷新

浏览器没有 MCP 状态 Remote，早期版本只能报 Loader 的启用状态。那不是用户问的问题。可观测的事实是**工具注册表**：MCP 服务器每暴露一个远端工具，注册表里就有一个 `mcp__<server>__<tool>` 命名的工具；连接失败的服务器注册数为**零**。

所以本包自带宿主半边：读 `ctx.tools.schemas()`，按该命名约定分组，把每个服务器的计数经自己的路由发给浏览器。能力条收起时直接显示工具总数（如 `MCP 29`）——"已连接"三个字是冗余的，数量本身就是证据。

能力条**每 15 秒重读一次（仅页面可见时）**，页面重新可见时立即重读。隐藏的标签页不花任何读取。轮询是静默的：不会把行翻成加载态，标记保持稳定，只有答案真的变了才变。

三道护栏让轮询不白花钱，各解决一种浪费：

| 浪费 | 护栏 |
| --- | --- |
| 每个 tick 复制整个工具目录 | 宿主半边缓存摘要，在 `tools/change` 时精确失效——从不用定时器。答案没变的轮询根本不调 `schemas()`。 |
| 重绘相同数据 | `samePayload` 比较能力条实际渲染的字段；没变的轮询返回同一个 state 对象，React 不调度渲染。 |
| 对慢 Host 叠请求 | in-flight 标志：读取未完成时的 tick 直接返回，不发第二个请求。 |

`loadedAt` 有意排除在比较之外——它每次都不同，放进去整个抑制就废了。面板显示的是当前载荷的时间戳，即"这个答案是什么时候取的"的诚实读法。

两个诚实的限制，都写在面板里：

- **这是轮询，不是推送。** DSH 确实在 Host 上发 `tools/change`，但把它转发到浏览器需要 Typert Remote Event 声明——对一个只读能力条来说是过多的机械。后果有界：掉线的服务器在一个周期内显示出来，不是瞬时。
- **连上但不暴露工具的服务器算 未连接。** 这是有意的。`dsh-mcp-client` 把连接对象（`ready`、`connectedAt`、重试监督器）保持私有，所以"连上了但零工具"和"从没连上"从外面看注册表都是零、无法区分。工具不可用的服务器两种情况下都不能用，所以安全的读法是 未连接——能力条就报这个。

## 故障会打断阅读；缺失不会

MCP 静默失败正是这个插件存在的理由：工具不工作了，唯一痕迹进了 Host 日志，GUI 里什么都没有。所以**故障**会自己弹对话框，不需要你点。

故障是一个精确形状，不只是"没有工具"：

| 情形 | 标记 | 弹窗 |
| --- | --- | --- |
| 至少一个服务器注册了工具 | 工具总数（如 `29`） | 否 |
| 配置并启用了 MCP，但没有任何服务器注册工具 | 连接故障 | **是，一次** |
| 完全没配置 MCP | 未连接 | 否 |
| 所有 MCP 行都被禁用 | 未连接 | 否 |
| 工具注册表读不动 | 读取失败 | 否 |

三个排除项和触发条件一样重要。没人配置的功能、故意关掉的服务器，去唠叨就是噪音——噪音会让插件被卸载，那才真没意义。注册表读失败被排除，是因为能力条真的无法判断有没有出问题，不能凭无知给人定罪。

每个不同的故障只弹一次（按受影响服务器名做 key），15 秒轮询不会每 tick 重新唠叨；点红色 连接故障 标记可在关闭后重新打开。弹窗列出每个受影响的服务器及其 Loader phase，并明说真实报错在 Host 日志里——能力条唯一拿不到的东西，说出来而不是糊弄过去。

## 两半如何通话

```
browser:  connection.rpc.call("/api", "ability-strip", payload)
host:     connection.fetch.register({ path: "/api/ability-strip", methods: ["POST"] })
wire:     request  { type: "client-request",  rpcId, payload: { action, data } }
          response { type: "server-response", rpcId, result }
```

`rpc.call` 靠读 `owner.webServer` 建专用通道，新版 harness 拒绝这样做，所以宿主半边改为在共享 `/api` 载体上注册**精确 Fetch 路由**——载体自己挂载该路由并施加同样的 owner-only 认证。这和社区 MCP 面板用的是同一机制。这里不依赖任何第三方插件。

两个 MCP 包是有意分开的。`@deepseek-ai/dsh-mcp-client` 是**每服务器一行**，所以那些行就是已配置的服务器列表。`@deepseek-ai/dsh-mcp-resources` 对所有服务器只挂**一次**、增加三个资源读取工具；把它算成服务器是错的，但完全藏起来又会隐藏"配置的服务器到底能不能读"。

## 它放在哪，为什么保持窄

能力条注册进 `conversation.composer.dock`——输入栏自己的 dock 元素，输入栏在它自己的输入行**之后**渲染它。`conversation.input.dock` 会落在输入框*上方*：它是 composer 栈里被输入栏跟随的子元素。别挪回去。

那个 dock 是与其他部件共享的一条 flex 行（本机上有两个会话统计部件、persona 条、上下文计）。在那里 `width: 100%` 什么也居中不了——它强迫整行溢出，把所有兄弟一起拖走，能力条自己的内容反而偏向一边。本机实测：整宽声明在 941 px 的行里占掉 **555 px**，内容只有 361 px；改为按内容定宽、把刷新控件挪进明细面板后，收起态缩到 **284 px**，去掉标题、改成 `skill N | MCP N` 的重设计又更窄。

所以：包裹层是 `flex: 0 1 auto`（内容宽），明细面板是 portal 到 `<body>` 的 fixed 浮层，打开它不改任何布局。dock 上 `justify-content: center` 居中不了这个组——那行是满的——能力条就待在 dock 放它的地方。

## 构造上就是只读的

浏览器半边只调三个只读 Remote：`skills/list`、`pluginInventory/list`、`pluginManager/listBundles`。宿主半边每个请求读一次工具注册表（`ctx.tools.schemas()`）。不注册、不写入、不变更、不持久化任何东西：没有工具、没有设置、没有配置文件、请求之间没有状态。唯一的生命周期对象是 Fetch 路由本身，effect 在 unload 时 dispose。

## 已知限制（面板里也写了）

- **轮询不是推送。** 工具总数每 15 秒重读一次（页面可见时，重新可见时立即读）。服务器在一次读取后马上掉线，会一直显示到下一个 tick。在 Host 上盯 `tools/change` 并转发到浏览器可以消除这个窗口，但需要 Typert Remote Event 声明——远超这个能力条应有的改动量。
- **连上但零工具读作 未连接。** 唯一的证据是注册到的工具。`dsh-mcp-client` 的连接对象是私有的，连接成功但不暴露工具的服务器和从没连上的服务器无法区分。两者都报 未连接，有意为之：工具不可用的服务器两种情况下都不能用。
- **没有连接细节。** 服务器真失败时，原因不在注册表里——它去了 Host 日志。能力条说不出为什么。

Loader 行只带 `entryId`、`moduleName`、`meta`、`enabled`、`fiberPhase`——**没有配置**——所以配置里的 `serverName` 从 inventory 拿不到。已连接的服务器改从工具注册表取名，面板才叫得出它们；Loader 行保留自己的行 id（本机是 `mcp-local`）。

## 安装

**当前安装形态（本机 `web` profile，2026-10-28）：`file:` tarball 拷贝安装，不是 link。** profile 的 `package.json` 记录 `dsh-ability-strip: file:<本目录>/dist/dsh-ability-strip-0.3.0.tgz`，`node_modules/dsh-ability-strip` 是 tarball 解开的普通目录（不是符号链接）——之后编辑这份源码树影响不到运行中的安装。为什么坚决不用 `link:`，见文末附录（历史决策记录，不是现状）。

从 tarball 安装，让 profile 持有的是一份**拷贝**：

```sh
pnpm pack --pack-destination dist
node scripts/verify-pack.mjs dist/dsh-ability-strip-0.3.0.tgz
dsh plugin --profile web add "<绝对路径>/dist/dsh-ability-strip-0.3.0.tgz"
```

发布一次源码改动 = 重新打包再 add：

```sh
cd <本目录>
pnpm check                       # 必须输出 RESULT: PASS
pnpm pack --pack-destination dist
node scripts/verify-pack.mjs dist/dsh-ability-strip-0.3.0.tgz
dsh plugin --profile web add "<绝对路径>/dist/dsh-ability-strip-0.3.0.tgz"
```

`dist/` 留在原地——profile 记录 tarball 的绝对路径，之后在该 profile 里 `pnpm install` 还需要文件存在。升级就是 pack + 再 `add`；卸载是 `dsh plugin --profile web remove dsh-ability-strip`。

`dsh plugin add` 会转发给 profile 内的 pnpm，然后自动把包追加进 `dsh.profile.bundles`，因为 `package.json` 声明了 `dsh.bundle.patch`（见插件管理器的 `reconcile`）。没有这个字段的包只会装成普通依赖，永远不加载。

然后**硬刷新页面**（`Ctrl+F5`）。Host 不需要重启：`dsh-hmr` 监视 profile 清单并重组层，但浏览器按 revision 缓存客户端 bundle，所以必须刷新。

0.3.0 是第一个带真实宿主半边的版本（宿主读工具注册表、MCP 工具数/连接故障、浮层面板），也是第一个走宿主端热重载路径的版本：安装它会让 Loader 加载新的宿主代码，而不只是新的浏览器 bundle。

## 附录：为什么拒绝 `link:` 和目录安装（历史决策记录，不是当前形态）

以下记录当初的决策依据：为什么安装介质必须是 tarball、为什么坚决不用 `link:`。**当前安装不是 link**（见上节）。

### 为什么在这里 `link:` 安装不安全——实测，不是假设

`dsh-client-modules` 把每个插件客户端 bundle 的**绝对**路径缓存在 `pkgMeta`，key 是 `` `${baseUrl}\0${loaderName}` ``，且**永不失效**（包内没有任何 `delete`/`clear`）。`captureArtifactBaseline()` 随后 stat 这个缓存路径来推导 revision，于是整个会话一直读的是**第一次**解析时记下的文件。

`link:` 安装记下的就是源码目录。卸载、从 tarball 重装、改 profile 都不清这个缓存：Host 会一直发工作树的文件，直到重启。这在本机实测到过——boot graph 发的是源文件的 revision，profile 里的拷贝原封未动。

不需要重启的修复是**换包名**：新的 specifier 就是新的缓存 key，第一次解析发生在 tarball 进 profile 之后，钉住的就是拷贝。这就是本包叫 `dsh-ability-strip` 而不是早先 `dsh-runtime-inspector` 身份的原因。

### 为什么是 tarball 而不是目录 / `link:`

已对照 pnpm 文档和 DSH 自己的 spec 解析器验证：

| spec 形态 | pnpm 结果 | DSH 解析为 |
| --- | --- | --- |
| `<绝对路径>.tgz` | store 里的解包拷贝 | `tarball` |
| `<绝对目录>` | **符号链接**，等同 `pnpm link` | `path` |
| `link:<绝对目录>` | **符号链接** | `path` |

pnpm 文档直说：从目录安装"会在 `node_modules` 里创建符号链接，等同于运行 `pnpm link`"。符号链接意味着改这棵树会不经评审直接改活的 UI，所以两种非 tarball 形态都被有意拒绝。

## 文件

| 路径 | 角色 |
| --- | --- |
| `cordis.patch.yml` | 往 Loader 插入承载本包的 Host 行 |
| `lib/index.js` | 宿主半边：读 `ctx.tools.schemas()`，服务 `/api/ability-strip` |
| `lib/client.js` | 浏览器半边：能力条本体，lazy-CJS `__ModuleLoader__` 形态 |
| `scripts/` | 四项验证检查（见下） |
| `dist/*.tgz` | 构建出的安装介质，不入 git |

## 环境要求

- DSH `>=0.2.0-rc.2`（声明为 `engines.dsh`，安装和启动时强制）

`engines.dsh` 很重要：没有它，一次改变客户端 slot API 的 DSH 升级会在运行时静默失败，而不是拒绝安装。有意不声明 `engines.node`——本包不添加任何 Node 版本相关的 Host 代码，DSH 自己也不声明 Node 范围，声明一个就是无根据的约束。

按官方 manifest 参考：

- `engines.dsh` 独自决定；声明它时 `peerDependencies` 被忽略，且预发布版本参与范围匹配——这就是 `>=0.2.0-rc.2` 能匹配运行中的 `0.2.1-rc.2` 的原因。
- `dsh.manifestVersion: 1` 标记 manifest 格式（与 npm、Session 版本无关）。
- `dsh.bundle.patch` 可以是一个路径或有序列表；本包用一个。
- 不兼容的 **bundle** 在启动时跳过并列入 `skippedBundles`，不会崩掉应用；不兼容的 **tarball 安装**在安装后判定再回滚。这就是范围要声明在这里而不是留空的原因。
- `dsh.client.external` 只用于非基线模块请求。本 bundle 只 import `react` 和 `@deepseek-ai/dsh-client-ui-primitives`，都在 shell 的静态表里，所以不需要 `external` 条目。

## 构建

没有构建步骤。`lib/client.js` 直接按模块系统期望的 lazy-CJS 形态编写——一次 `window.__ModuleLoader__.load({ id, factory })` 注册，factory 只 `require` 基线模块。Host 原样发这个文件，revision 由 mtime/size 推导，无需编译。`scripts/` 里的检查就是编译器本该提供的安全网，且不需要浏览器就能跑。

## 验证

不涉及浏览器。四项检查直接对着真实源码跑：

```sh
node scripts/check-host.mjs              # mcp__ 拆分、按服务器汇总、路由契约
node scripts/check-bundle-contract.mjs   # loader 注册 + slot + inject 契约
node scripts/check-render.mjs            # 渲染能力条的每一种显示状态
node scripts/verify-pack.mjs <tarball>   # tarball 与本树一致，引用齐全
pnpm check                               # 前三项一起
```

每项钉死什么：

- **check-host** 导入 `lib/index.js`，钉死承重假设：`mcp__<server>__<tool>` 拆分，包括服务器名本身含 `__` 的情况（在**最后一个**分隔符处拆）以及拒绝非 MCP 名。随后检查汇总形状、注册表抛错变成 `error` 而不是静默零、`apply()` 在 `/api/ability-strip` 恰好注册一个应答载体 `client-request` 信封的 POST 路由且对不可解析的 body 回 400，以及——轮询成本保证——重复读取**不会**再调 `schemas()`、`tools/change` 恰好失效一次缓存、unload 同时丢掉路由和监听器。
- **check-bundle-contract** 用一个桩 `window.__ModuleLoader__` 求值 `lib/client.js`，断言 factory id 等于包名、只 require 基线模块（`react`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`）、导出的 `inject` 列表覆盖实际读取的每个 Remote 和 service（含 `connection`），且 `apply()` 恰好往 `conversation.composer.dock` 注册一个组件、inject face 暴露 `load` 且*不*遮蔽内置 `sessionId` prop。
- **check-render** 用一个小 hook 运行时构建树，桩掉 `document.body` 和 `createPortal` 记录器，断言每种显示状态下读者可见的文本：首绘（pending，从不下假结论）、已加载（`skill N`、MCP 工具数、不打印服务器 id）、**配置了服务器但零工具注册时读作 未连接**且仍列为已配置、展开态（portal 面板带两节标题、skill `/name`、`whenToUse`、已连接服务器及工具数和工具名称、Loader phase、资源插件行、bundles、刷新与关闭控件）、无资源插件、工具注册表失败（`读取失败`，绝不静默报已连接/未连接）、skills/bundles 独立失败、空但成功的读取（`未连接`）、以及 load 抛错（错误必须可见）。它还证明收起态不构建任何明细树（dock 在 composer 每次击键都会重渲染），并钉死全部三道轮询护栏：隐藏标签页不花读取、没变的轮询返回同一个 state 对象（不渲染）、in-flight 期间的 tick 不发新请求。三者各有一条变异测试：去掉护栏，对应检查就失败。
- **故障触发有自己的变异矩阵。** 三个条件每一个都被证明是必要的——破坏它、看对应检查失败：去掉 `tools.error` 会让读不动的注册表弹窗，去掉"有启用行"要求会让没配置的 profile 弹窗，把"没有服务器"强制为 false 会让真故障漏报。每条否定检查都跑完整的提交序列，否则错误弹开的对话框根本到不了可见阶段。
- **verify-pack** 解开 `.tgz` 与本树逐条比对（`package.json` 按值比，因为 pnpm 会重写其格式），并检查 `main` / `exports` / `files` / `dsh.bundle.patch` 引用的每个文件确实在载荷里。

这些能抓住 `node --check` 抓不住的：未定义标识符、写错的 slot 名、读了 Remote 却没声明对应 inject、以及与 MCP 客户端约定不一致的工具名拆分。

## 验证状态

- `pnpm check`（check-host / check-bundle-contract / check-render）在当前树上全部通过（跑一遍，输出就是证据）。
- `verify-pack` 是打包介质比对：0.3.0 打包时通过。README 这类文档改动会让已打包的 tarball 与当前树不一致——发下一版时重新 `pnpm pack` 后再跑。
- **0.3.0 已在运行中的 Host 上验证**（2026-10-28，本机）：Loader 加载了宿主半边，`/api/ability-strip` 路由注册成功，浏览器→宿主 RPC 往返成功；页面实测收起态 `skill | 22 | MCP | 29`，点击行展开明细、列出 29 个工具名称，再次点击收起；MCP 故障弹窗的触发与关闭也实测过。
- 早期版本的实测记录：能力条渲染在 `[data-composer-dock]`、编辑器下方；所发 bundle 的 revision 等于已安装拷贝的 `artifactRevision`，而不是源码树的——这个测量证明 `lib/` 下的代码已不是页面运行的代码。
