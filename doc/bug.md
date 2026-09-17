# Damuku_music 代码与界面审查记录

审查日期：2026-09-07

## 1. 范围与结论

本次检查覆盖：

- `src/public/` 下主页面、设置页、启动器、组件、音乐/弹幕服务和全部 CSS；
- `app.js`、`src/routers/`、`src/services/`、配置、启动/停止/构建脚本；
- `src/types/`、现有测试和开发文档；
- 控制页与设置页的实际浏览器渲染（默认视口和 300×800 窄屏）。

按要求不检查本地部署中的安全加固问题。未使用真实账号验证网易云、QQ 音乐和 B 站在线接口，因此第三方接口变更不在“已确认”范围内。

严重度说明：

- **P1**：直接导致主要功能开关失效、播放状态竞争或明显错误行为，应优先修复；
- **P2**：在明确条件下出现的功能、兼容或可用性问题；
- **P3**：低频边界、冗余、类型/构建/测试债务或界面细节。

本次未发现 P0（数据不可恢复或程序完全不可用）问题。现有自动化结果为：`npm test` 34/34 通过，`npm run typecheck` 通过；浏览器空队列冒烟检查未出现 console error。通过这些检查不代表下列问题不存在，具体测试盲区见第 5 节。

## 2. 优先修复的功能问题

### BUG-001 [P1][已确认] 直播模式的两个显示开关被 `!important` 覆盖

- 位置：`src/public/styles/main-page.css:704-724`；设置入口：`src/public/index.html:538-544`。
- 现象：`body.liveMode .queueHeader` 被强制设为 `display: flex !important`，点歌人列被强制设为 `display: table-cell !important`；后面的“不显示”规则没有 `!important`，因此无法覆盖。
- 影响：“队列标题和数量”和“点歌人”即使关闭，直播/OBS 页面仍然显示，设置项实际失效。
- 建议：移除前面的 `!important`，或让显示/隐藏都只由 `liveShowQueueHeader`、`liveShowRequester` 状态类控制；补一条计算样式测试。

### BUG-002 [P1][高置信度] 同步命令表面串行，实际播放任务仍会并发

- 位置：`src/public/components/music-player.js:1158-1170, 1458-1470`。
- 触发：短时间连续收到 `next`、`addOrder`、`loadSongList` 或 `play` 命令。
- 原因：命令拉取循环使用 `await this.handleCommand(command)`，但 `handleCommand()` 内调用 `this.playCanonicalState(...)` 时没有 `await`。
- 影响：取播放 URL、恢复进度、切换 `audio.src` 的多个任务可能交叉完成，旧任务可能覆盖新歌曲，表现为跳错歌、回跳或播放状态抖动。
- 建议：在命令分支中 `await this.playCanonicalState(...)`；若确实需要并发，应建立显式播放任务队列或版本令牌，旧任务提交结果前必须确认仍是当前命令。

### BUG-003 [P2][已确认] 二维码刷新会累积轮询，慢请求还会重叠

- 位置：`src/public/components/login-configer.js:199-236`。
- 触发：连续点击“刷新二维码”，或 `checkQrStatus()` 一次耗时超过 3 秒。
- 原因：每次调用都创建局部 `setInterval`，实例上没有保存当前计时器；异步 interval 也不等待上一轮完成。
- 影响：旧二维码 key 继续请求；多个响应可能交错写入 Cookie、刷新登录状态并重复提示；慢网时会并发发起同一状态请求。
- 同一流程还有两个反馈问题：获取 key 失败时把文字写入 `<img>` 的 `textContent`（`login-configer.js:204-206`），页面看不到；异步调用整体没有 `try/catch`，抛错后没有可见错误状态。
- 建议：保存 `this.qrCheckTimer` 和请求版本；刷新前清理旧任务；使用递归 `setTimeout` 或 in-flight 标记；失败信息写到状态元素/提示框。

### BUG-004 [P2][高置信度] 队列管理请求抛异常后可能永久锁住按钮

- 位置：`src/public/components/queue-manager.js:301-362`。
- 触发：`sendCommand()`、`applySharedState()` 或刷新过程抛出异常。
- 原因：`promote()`、`remove()`、`saveOrder()` 在请求前将 `this.busy = true`，但没有 `try/finally`；异常会跳过恢复语句。
- 影响：`render()` 会一直按 busy 状态禁用队列操作，除非刷新整个页面。相邻的 `addSearchResult()` 已正确使用 `try/finally`（`queue-manager.js:219-240`），实现风格也不一致。
- 建议：三个方法统一使用 `try/catch/finally`，在 `finally` 恢复 busy 并渲染；错误信息统一进入状态栏。

### BUG-005 [P2][已确认] 不同音乐平台相同 SID 会被误判为重复歌曲

- 位置：`src/routers/bili-router.js:208-211, 928-930`。
- 触发：网易云与 QQ 音乐恰好存在相同字符串 SID，后一首加入同一队列。
- 原因：重复检查只比较 `item.song.sid === order.song.sid`，没有比较平台；文件中已有包含平台的 `songKey(song)`，却未在这里使用。
- 影响：合法歌曲被拒绝并提示“歌曲已在点歌列表中”。
- 建议：统一用 `songKey()` 比较。歌曲黑名单当前也只按 SID 比较（`bili-router.js:923-925`），应先确认产品语义是跨平台屏蔽还是按平台屏蔽。

### BUG-006 [P2][已确认] 非整数 `idleIndex` 会让空闲歌曲轮播静默失效

- 位置：`src/routers/bili-router.js:288-293, 788-799, 944-950, 1063-1072`。
- 触发：同步状态传入 `idleIndex: "abc"`、`NaN` 等非有限值，或传入 `1.5` 等小数。
- 原因：归一化只做 `Number()` 与 min/max，没有验证有限整数。无效值经过取模仍为 `NaN`/小数，无法从数组取到歌曲。
- 影响：需要从空闲歌单补歌时 `normalizeOrder()` 得不到有效歌曲，队列保持为空，播放/下一首会停在“等待点歌”。当前 JavaScript 对 `{...undefined}` 不会抛错，因此这里是静默失效，不是 500 崩溃。
- 建议：输入先 `Number.isFinite`，再 `Math.trunc` 并限制范围；`appendNextIdleSong()` 对索引和候选歌曲再做一次防御检查。

### BUG-007 [P2][已确认] 跨源删除登录态会被 CORS 预检拦截

- 位置：`src/routers/bili-router.js:1141-1147, 1268-1272`。
- 触发：直播姬/嵌入 WebView 以不同 origin 发起 `DELETE /live/sync-credentials`。
- 原因：CORS 只允许 `GET,POST,PUT,OPTIONS`，实际路由却使用 `DELETE`。
- 影响：预检响应虽然是 204，浏览器仍不会发送 DELETE，请求表现为清除登录态失败。
- 建议：允许方法加入 `DELETE`，并为 OPTIONS 响应补接口测试。

### BUG-008 [P2][已确认] 重复提示会创建永不释放的永久定时器

- 位置：`src/public/utils/common.js:47-52`；调用点：`src/public/services/danmuServers/bilibili-server.js:38, 62, 97, 110`。
- 原因：`pageAlertRepeat()` 每次都创建 `setInterval`，不返回句柄、不按消息去重、没有停止入口。
- 影响：多次连接错误会累积多个 7 秒计时器，提示成倍出现并持续到页面关闭；缺少房间号时第一条可见提示还要等 7 秒。
- 建议：按错误 key 维护唯一计时器，连接恢复时停止；或改成一次提示加节流/退避。

### BUG-009 [P2][高置信度] 共享歌词请求绑定了首个消费者的取消信号

- 位置：`src/public/services/lyric-service.js:15-50`；调用位置：`src/public/components/music-player.js:527-562`。
- 触发：同一歌曲的第二个调用复用 in-flight Promise，首个调用随后因切歌而 abort。
- 原因：底层 `getLyrics()` 使用首个调用者的 `signal`，但 Promise 被所有同 key 调用者共享。
- 影响：首个消费者取消会把仍然需要结果的其他消费者一起取消。
- 建议：共享底层请求不要直接绑定单个消费者 signal；为消费者单独包装取消，只有最后一个消费者退出时才取消底层请求。增加“两次同 key load、只 abort 第一次”的测试。

### BUG-010 [P3][潜在问题] 歌词缓存清理存在旧请求删除新请求的竞态

- 位置：`src/public/services/lyric-service.js:42, 59`。
- 触发：旧请求未结束时调用 `clearMemoryCache()`，随后同 key 创建新请求。
- 原因：旧 Promise 的 `finally` 无条件 `lyricInflight.delete(key)`，可能删掉后来放入的 Promise。
- 影响：之后的调用无法复用新请求，造成重复网络请求。当前仓库没有调用 `clearMemoryCache()`，所以这是公开方法中的潜在 bug，同时也可能是尚未使用的冗余 API。
- 建议：仅在 `lyricInflight.get(key) === request` 时删除；若无使用计划则移除该方法。

### BUG-011 [P3][边界问题] 只有翻译歌词时最终会显示为空

- 位置：`src/public/services/musicServers/wy-music-server.js:316-328`、`src/public/services/lyric-parser.ts:107-118`、`src/public/services/lyric-service.js:31-35`。
- 触发：接口返回带时间戳的 translation，但 original 为空，且没有 `nolyric/uncollected` 标记。
- 原因：歌词行只从 original 生成，translation 只能合并到已存在的原文行。
- 影响：可用译文被归类为 empty。
- 建议：明确产品语义；若允许译文独立显示，则在 original 为空时用 translation 建行。

### BUG-012 [P3][设计需确认] 房间级凭据接口与全局持久化模型不一致

- 位置：`src/routers/bili-router.js:1247-1272`、`src/services/local-store.js:217-240`。
- 现象：内存凭据按 room 保存，GET 还会回退到一个全局 Cookie 文件；删除一个 room 时会无条件清除全局 Cookie。
- 影响：如果产品期望房间间隔离，清除 A 房间登录态会影响 B 房间；如果产品期望全局登录态，接口的 room 语义和内存 Map 又会误导维护者。
- 建议：先明确凭据作用域，再统一 GET/POST/DELETE 和落盘结构。

## 3. 界面与交互一致性

### UI-001 [P2][浏览器已复现] 300px 窄屏下主控制按钮被压成竖排文字

- 位置：`src/public/styles/main-page.css:565-593`。
- 原因：`.playerActions` 固定单行 flex，没有换行规则；按钮有左右 padding，但没有最小宽度或不换行约束。
- 实测：300px 视口下按钮容器宽 224px，四个按钮宽度约 39/50/61/50px，高度都被撑到 76px，“启用声音”“下一首”逐字换行。
- 影响：操作区明显失真，按钮难以快速识别；与其他圆角横向按钮风格不一致。
- 建议：在窄屏改为 2×2 grid/flex-wrap，或保留单行但降低 padding、加 `white-space: nowrap` 和合理最小宽度。建议至少验证 300、360、420px。

### UI-002 [P2][浏览器已复现] 设置页导航和表单在窄屏被直接裁掉

- 位置：`src/public/styles/setting-page.css:301-363`，尤其 `setting_menu` 不换行和 `setting_body { overflow-x: hidden; }`；现有唯一窄屏规则只处理队列项（`setting-page.css:833-838`）。
- 实测：300px 视口下六个导航按钮的最右边界依次延伸到 97、171、245、319、393、443px，但页面横向宽度仍为 300px，后半导航不可见且不能横向滚动；表单右侧控件也被裁切。
- 影响：“显示设置”“队列管理”“关于”无法正常点击，部分输入和按钮只显示一部分。
- 建议：导航允许横向滚动或折成两行；设置表格在窄屏改为标签/控件上下布局；不要用 `overflow-x: hidden` 掩盖溢出。

### UI-003 [P2][已确认] 设置页统一移除了焦点轮廓，键盘焦点不清晰

- 位置：`src/public/styles/setting-page.css:476-531, 538-548, 575-579`。
- 现象：文本框、搜索框、数字框、选择器、textarea、颜色框、checkbox 和按钮都使用 `outline: none`；focus/focus-visible 只保留低对比度边框或阴影。
- 影响：键盘操作时很难判断焦点位置，尤其深色背景和低亮度显示器下。
- 建议：统一使用高对比度 `:focus-visible` 外轮廓；鼠标 focus 可弱化，但不能同时清除所有可见焦点提示。

### UI-004 [P3][已确认] 长提示消息被单行省略，用户无法查看完整错误

- 位置：`src/public/styles/main-page.css:824-862`。
- 原因：提示最大宽度 360px，同时强制 `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`，没有展开或详情入口。
- 影响：连接错误、接口错误等较长信息在窄窗口只剩前半句，排障信息丢失。
- 建议：允许 2～3 行，使用 `overflow-wrap: anywhere`；必要时增加详情或可复制文本。

### UI-005 [P3][已确认] 二维码图片缺少可见失败替代信息

- 位置：`src/public/index.html:171-173`、`src/public/components/login-configer.js:204-206`。
- 现象：`<img id="qrImg">` 没有 `alt`；失败时写 `img.textContent`，实际不会显示。
- 建议：增加描述性 alt，并用相邻状态元素显示“加载中/失败/过期/成功”。

### UI-006 [P3][已确认] CSS 选择器作用域不一致

- 位置：`src/public/styles/setting-page.css:292-297`。
- 现象：`.setting_order_page #userBlackList, #songBlackList` 的第二段是全局 `#songBlackList`，没有受 `.setting_order_page` 限制。
- 影响：当前 ID 唯一时暂不出错，但以后复用组件或改 DOM 时可能发生意外样式污染，也让两个同类列表的规则写法不一致。
- 建议：改为 `.setting_order_page #userBlackList, .setting_order_page #songBlackList`。

### UI-007 [P3][低优先级] 弹幕测试表格没有窄屏策略

- 位置：`src/public/danmu-test.html:8-17, 29-31`。
- 现象：五列表格直接占 100% 宽度，没有横向滚动容器或隐藏低优先级列。
- 影响：手机宽度下 UID、用户名、弹幕和 ID 相互挤压。该页面是测试工具页，因此优先级较低。
- 建议：表格外包可横向滚动容器，或在窄屏折叠时间/ID 列。

## 4. 类型、构建、冗余与文档问题

### CODE-001 [P2][已确认] `MusicServer` 类型与两个运行时实现不一致

- 类型：`src/types/song.ts:33-38` 声明 `search/getSong/getUrl/getLyrics`。
- 网易云实现：`src/public/services/musicServers/wy-music-server.js:179, 231, 238, 285` 实际为 `searchSongs/getSongInfo/getSongUrl/getLyrics`。
- QQ 实现：`src/public/services/musicServers/qq-music-server.js:52, 84` 只有 `getSongInfo/getSongUrl` 等方法，没有完整接口。
- 影响：类型检查通过并不能证明真实对象满足接口；未来 JS 转 TS 时会集中爆出契约错误。QQ 歌词当前也被 `lyric-service.js:15-18` 明确判为 unsupported。
- 建议：按真实适配层统一方法名；对“搜索/详情/URL/歌词/歌单”使用能力接口或明确的可选能力，并让实现真正参与类型检查。

### CODE-002 [P2][已确认] `DisplaySettings` 缺少九个已持久化字段

- 位置：`src/types/settings.ts:15-42` 对照 `src/services/local-store.js:21-29, 89-97`。
- 缺失：`overlayBackgroundColor`、`playerTitleColor`、`playerTitleSize`、`playerArtistColor`、`playerArtistSize`、`queueTextColor`、`queueTextSize`、`queueHeaderColor`、`queueHeaderSize`。
- 影响：`SettingsPatch.display` 无法准确描述真实设置，类型声明和服务端保存结果持续漂移。
- 建议：补齐字段，并给 `mergeSettings()` 输入/输出接上该类型。

### CODE-003 [P2][已确认] 浏览器事件类型连事件名和 detail 结构都与运行时不符

- 类型：`src/types/browser-events.ts:3-5, 20-22` 声明 `damuku:room-state`，detail 为 `{ roomId, state }`。
- 运行时：`src/public/components/music-player.js:1715` 派发 `damuku-room-state`，detail 直接是 `state`；`src/public/components/queue-manager.js:29` 也监听连字符事件并直接消费 `event.detail`。
- 影响：按类型编写的代码既监听不到真实事件，又会错误读取 `event.detail.state`。
- 建议：以当前运行时协议为准修正事件名和 payload，或一次性修改发送端/接收端/类型；增加浏览器事件集成测试。

### CODE-004 [P2][已确认] 构建产物不参与实际启动，`build` 与“生产”链路脱节

- 构建：`package.json:17-20`、`scripts/build-client.cjs:5-28`、`scripts/build-server.cjs:1-10` 写入 `dist/`。
- 启动：`package.json:7-10` 和 `ecosystem.config.js:5` 始终执行根目录 `app.js`；`app.js:49-80` 仍写入/提供 `src/public`。
- `tsconfig.server.build.json` 只编译 `src/types/**/*.ts`，`dist/server` 不是可运行服务端。
- 影响：`npm run build` 成功也不能验证实际生产入口；`dist/public` 与源码可以长期不同步，容易让维护者误以为正在运行编译后的歌词解析器。
- 建议：二选一：明确 `build` 只是迁移实验并从常规命令/文档中降级；或完成真正的 dist 启动链路，让 PM2、启动器、静态目录都指向构建产物。

### CODE-005 [P3][已确认] `doc/to_ts.md` 已过期并自相矛盾

- 位置：`doc/to_ts.md:22-27, 229-241`。
- 现象：文档“当前基线”仍写没有 TypeScript/构建流程，但仓库已经有 TS 依赖、类型、tsconfig 和 build scripts；同一文档又要求生产运行 dist，而当前代码没有做到。
- 影响：迁移进度和验收状态不清楚，容易按错误步骤发布。
- 建议：把每一阶段标注为“未开始/进行中/完成”，并把当前实际运行入口单独列出。

### CODE-006 [P3][已确认] 手写 `.ts`/`.mjs` 两份歌词解析器造成双源漂移

- 位置：`src/public/services/lyric-parser.ts` 与 `src/public/services/lyric-parser.mjs`；测试入口：`test/lyric-service.test.js:5, 19`。
- 差异：TS 使用 `String(value ?? '')`，MJS 使用 `String(value || '')`；`songId` 等边界输入的语义不同。开发态加载 MJS，构建脚本则用 TS 编译结果覆盖发布 MJS。
- 影响：测试只覆盖开发态 MJS，构建后行为可能不同；修复时需要同步改两份。
- 另有明确死逻辑：`findLineIndex()` 在 TS `:103-105`、MJS `:92-94` 返回 `condition ? candidate : candidate`，`endMs` 判断完全无效。
- 建议：保留一个源文件并自动生成兼容产物；测试构建产物或直接测试 TS 源；删除无效条件或实现真正的结束时间语义。

### CODE-007 [P3][已确认] 浏览器仍加载完全未使用的 `pako`

- 位置：`src/public/index.html:12-13`。
- 证据：全仓前端没有任何 `pako` 引用；实时弹幕压缩已在 Node 服务端处理。
- 影响：每次页面多一个外部 CDN 请求，离线/弱网多一个失败点，也增加无意义的页面初始化成本。
- 建议：删除 pako script；若仍需浏览器端解压，应补回明确调用和依赖说明。

### CODE-008 [P3][已确认] 静态资源版本 query 仍由多处手工维护

- 位置：`src/public/index.html:10, 17, 19, 21, 23`、`src/public/main.js:1-2`、`src/public/components/queue-manager.js:1-2`、`src/public/launcher.html:7`。
- 现象：资源 query 混有 `20260809-16`、`20260831-7`、`20260902-3`；修改 `config/version.js` 不会同步这些字符串。
- 影响：当前 `app.js:81-86` 的 no-store 缓解了缓存问题，但文档所称“统一构建号”并未真正统一；移除 no-store 或换到别的静态服务器后容易加载旧模块。
- 建议：构建/启动时统一注入 buildId，或在服务端用版本化清单生成 HTML/入口导入。

### CODE-009 [P3][已确认] Windows 启动脚本只用 Express 判断依赖是否完整

- 位置：`启动点歌台.bat:29-36`。
- 触发：`node_modules` 部分损坏，Express 仍在但 axios/yaml/pm2/typescript 等缺失。
- 影响：脚本跳过安装，随后启动或类型/构建命令才失败，提示与“首次运行检测”不一致。
- 建议：使用 lockfile 对应的完整安装状态，或始终执行可增量的 `npm install`；至少检查所有运行时依赖而不是单包。

### CODE-010 [P3][已确认] 停止脚本把基础路径写死为 `/order`

- 位置：`scripts/stop-project.ps1:53-55`。
- 触发：`config/webapi.js` 的 `BASE_PATH` 改为其他值，同时只能靠端口探测识别服务。
- 影响：健康探测访问错误地址，脚本可能报告找不到项目服务而未停止它。
- 建议：和 `src/config.js` 共用基础路径规范化逻辑，或从配置读取 BASE_PATH 后构造探测 URL。

### CODE-011 [P3][已确认] 使用说明引用了不存在的开发文档

- 位置：`使用说明.md:687-695`。
- 缺失：`doc/live_danmu_realtime_mode.md`、`doc/get_live_damu.md`、`doc/get_lyric.md`、`doc/insert_music.md` 均不在当前仓库。
- 影响：读者无法按文档继续排障；也会误以为关键协议已有完整说明。
- 建议：恢复这些文档，或删除失效目录并把仍有效的内容合并到 README/使用说明。

### CODE-012 [P3][已确认] `doc/script.md` 是过期且易误用的临时命令记录

- 位置：`doc/script.md:1-7`。
- 现象：包含 `taskkill /IM node.exe /F` 和两个硬编码 PID，没有标题、适用条件或警告；仓库已经有会验证项目路径的 `清理点歌台进程.bat`/`scripts/stop-project.ps1`。
- 影响：照抄会终止本机所有 Node 进程，硬编码 PID 也早已失效；与正式停止脚本重复且更不可靠。
- 建议：删除该临时记录，或改成只链接正式停止脚本的排障说明。

## 5. 测试与静态检查盲区

### TEST-001 [P2] `typecheck` 通过，但几乎没有检查主要 JavaScript 实现

- `tsconfig.server.json` 只 include `src/types/**/*.ts`；`tsconfig.client.json` 只 include 类型与 `lyric-parser.ts`。
- `allowJs: true` 但 `checkJs: false`，且主要 JS 文件不在 include 内。
- 后果：CODE-001、CODE-003 这类明显契约错误仍能全部 typecheck 通过。
- 建议：先给边界模块加 `// @ts-check`/JSDoc 并逐步纳入 include，不要把当前 typecheck 当成全仓类型保障。

### TEST-002 [P2] 歌词服务核心缓存/取消/状态分支没有测试

- 位置：`src/public/services/lyric-service.js:15-51` 对照 `test/lyric-service.test.js:4-20`。
- 当前测试只覆盖解析器的 `parseLrc/findLineIndex/mergeTranslation`，没有导入 `LyricService`。
- 建议覆盖：unsupported、TTL、同 key 去重、AbortError、普通 error、instrumental、empty、ready、返回值深拷贝、清缓存竞态、translation-only。

### TEST-003 [P3] B 站前端门控测试依赖源码字符串顺序

- 位置：`test/bili-live-ws.test.js:20-48`。
- 现象：用 `source.indexOf(...)` 判断片段先后，而不是实例化组件验证行为。
- 影响：改变量名/注释可能误报，逻辑坏掉但字符串仍在也可能漏报。
- 建议：使用 fake WebSocket/DOM 验证 `realtime=1`、debug 和 mirror gate 的真实行为。

### TEST-004 [P2] 缺少浏览器响应式和关键交互冒烟测试

- 当前无测试覆盖直播显示开关、300/360/420px 布局、二维码重复刷新、队列请求异常恢复、同步命令严格串行。
- 本次浏览器检查已经稳定复现 UI-001/UI-002，说明纯 Node 测试无法覆盖这些回归。
- 建议：增加最小 Playwright 冒烟集，不需要测试全部视觉细节，只断言关键元素可见、未被裁切、开关后的 computed style 和异常后的按钮恢复。

### TEST-005 [P3] 配置边界覆盖不足

- 位置：`src/config.js:5-9` 和 `test/config.test.js:17-33`。
- 当前未覆盖 `normalizeBasePath()` 的空值、根路径、重复斜杠，也没有覆盖自定义 BASE_PATH 与停止脚本的组合。
- 建议：补 base path 归一化、环境 buildId、默认/自定义配置根目录测试。

## 6. 建议修复顺序

1. 先修 BUG-001、BUG-002：它们分别是确定失效的用户开关和播放竞争风险。
2. 接着修 BUG-003、BUG-004、BUG-005、BUG-006、BUG-007、BUG-008：改动范围局部、收益直接。
3. 同时补 TEST-004 的最小浏览器冒烟，锁住直播开关、窄屏和队列 busy 恢复行为。
4. 再统一事件/设置/音乐服务类型（CODE-001～003），否则 TS 迁移继续建立在错误契约上。
5. 最后决定生产是否真正切到 dist，再清理双份歌词解析器、无用 pako、旧 build query 和过期文档。

## 7. 本次未列为问题的项目

- `.playerCard[hidden]`、歌词覆盖层等位置使用 `display: none !important` 是为了保证原生 hidden 语义，属于有意设计。
- `prefers-reduced-motion` 已覆盖歌词滚动和进度动画，不重复列为动效问题。
- 启动器已有 640px 响应式规则，当前未发现同等级的布局缺陷。
- 弹幕测试页与主产品页配色不同，但它明确是内部测试工具，因此只记录表格可用性，不要求视觉完全一致。

## 8. 2026-09-07 修复状态

本轮已按上述建议完成以下修复：

- BUG-001～BUG-011：已修复。包括直播队列样式覆盖、播放命令串行等待、二维码轮询与失败恢复、队列 busy 状态、跨平台歌曲去重、空闲索引归一化、DELETE 预检、重复提示定时器、歌词请求取消隔离、歌词缓存清理竞态，以及仅有翻译歌词时的渲染。
- UI-001～UI-006：已修复。窄屏播放器会自动换行，设置页允许横向查看，恢复键盘焦点样式，长提示可换行，二维码补充替代文本并显示错误状态，选择器样式限制在点歌台页面内。
- UI-007：已修复，弹幕测试表增加横向滚动容器和最小表格宽度，窄屏下不再挤压列内容。
- CODE-001～CODE-003：已修复 TypeScript 契约（音乐服务、显示设置、浏览器事件）。CODE-005～CODE-007、CODE-009～CODE-012 已同步文档、移除无用依赖、增强启动/停止脚本并修正文档链接。
- CODE-008：已将现有静态资源查询参数统一到当前 `config/version.js` 的 buildId；未来仍建议由构建流程自动注入，避免人工更新。
- TEST-005：已补充 `normalizeBasePath()` 的边界测试；自定义配置目录的组合测试仍可继续扩展。

以下项目没有擅自改变架构或产品语义，暂留为后续决策：

- BUG-012：已补上跨页面凭据同步（GET 返回本机运行时 Cookie，播放页注入内存服务）；房间级/全局凭据的持久化和删除语义仍需产品设计后再拆分。
- CODE-004：生产是否切换到 `dist/` 需要明确部署策略；当前先保持 `app.js` 直接加载源码，避免改变启动行为。
- TEST-001～TEST-004：类型检查覆盖、歌词服务单元测试、真实 B 站 WebSocket 行为测试和浏览器响应式冒烟测试仍是后续测试建设项。

回归结果：`npm test` 通过 39 项，`npm run typecheck` 通过，源码 JavaScript 语法检查通过，停止脚本 dry-run 通过。
