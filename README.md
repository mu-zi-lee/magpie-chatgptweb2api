# magpie-chatgptweb2api

把实际的 ChatGPT 网页聊天包装成 Magpie 文本供应商。TypeScript + Playwright；插件自己管理专用浏览器和私有 worker，无需 Docker 或额外 HTTP 服务。

**当前是实验原型，尚未发布到 npm。匿名文本已实测成功；Cookie 可恢复真实账号状态，普通 Edge 手动登录和网页聊天已由用户确认，插件账号文本调用尚未跑通完整回复。** 本地网页测试与真实上游测试是两件事，验证记录见 [docs/verification.md](docs/verification.md)。

## 本地试用

需要 Node 22+。Magpie 自带的 Bun 负责插件运行；Chromium 或本机 Chrome/Edge 需另行准备。

```sh
npm install
npm run build
npm run browser:install
npm run guest
npm run chat -- --prompt '请用中文介绍一下自己'
npm run doctor
```

`guest` 打开独立匿名浏览器并验证输入框，成功后复用同一 profile，不按请求重置匿名会话。匿名入口是否可用以实际网页为准；若网页要求验证，在专用窗口中处理。匿名模式不代表拥有订阅模型权限。

**推荐手动登录**：需要账号模式时运行 `npm run login`。密码、验证码和 Google 登录均在网页里完成，插件只检测登录完成并保存本地关联。正常完成登录、验证或两步认证后，程序在聊天输入框出现时自动保存本地关联。默认新 profile 使用 `keep-open` 模式：浏览器正常启动，插件连接同一个浏览器。CLI 完成、worker 重启或空闲断开后，登录窗口继续打开；文本请求只新建及关闭自己的标签页。无需复制网页 Cookie 或 Access Token。浏览器启动失败时可配置本机可执行文件或浏览器 channel，见下文。

先用 CLI 验证真实网页，再在 Magpie 中添加本地目录：

```sh
magpie plugin add /Users/lee/Documents/Project/magpie-chatgptweb2api
magpie plugin login chatgpt-web
```

路径替换为实际克隆位置。添加账号时可选择 **匿名网页会话（无需登录）**、**手动登录 ChatGPT（推荐）** 或 **导入 ChatGPT Cookie（本地文件）**，模型选择 **ChatGPT Web → ChatGPT Web · 当前网页模型**。CLI 与 Magpie 分别建立关联；CLI 的选中 profile 不会自动导入 Magpie。

仓库将 `dist/` 构建产物随源码保留，供 Git spec 安装使用。修改源代码后必须运行 `npm run build` 同步构建产物。当前工作区的代码没有自动推送或发布。

## 保留登录窗口

本机 Edge 的推荐试用方式：

```sh
npm run login -- --options examples/edge.options.json
npm run doctor -- --options examples/edge.options.json
npm run chat -- --options examples/edge.options.json --prompt '请只回复：文本测试成功'
```

这会创建一个新的插件专用 profile。登录期间不用切换或重启窗口；Google 是否允许该窗口登录、ChatGPT 是否要求验证仍以网页实际行为为准，不能保证自动化连接后上游一定接受请求。

`browserMode` 有两个值：`keep-open`（新 profile 默认，窗口由用户关闭）和 `managed`（原行为，插件退出或空闲会关闭浏览器）。模式写入 profile，新配置不会转换已有 profile。旧 profile 没有模式字段时按 `managed` 处理。

保持窗口模式将调试端口绑定到本机 `127.0.0.1`，使用随机端口及独立配置目录。端口可以操作整个专用浏览器，不应公开到网络；不会连接个人浏览器。浏览器保持打开会继续占用内存。

已经打开、未启用连接的普通浏览器不能原地接管。遇到 `browser_connection_unavailable` 时，插件保留现有窗口；等你方便时自行关闭，再开始新的保持窗口登录。不要将个人浏览器配置目录设为 `profilesDir`。Magpie 登录等待失败后，可选择 **继续已有浏览器登录**，输入登录提示中的 profile UUID，继续同一个 profile。登录超时后可用 `npm run login -- --profile UUID --options examples/edge.options.json` 继续等待同一 profile，不用新建账号目录。

`doctor` 返回 `browserMode` 和 `windowKeptOpen`，后者说明清理策略，并不意味着上游文本已经测试成功。退出 CLI、重启 Magpie 后会重新连接仍打开的专用浏览器；你手动关闭浏览器后，下次使用再打开同一 profile。

## 导入 Cookie 登录

从自己的已登录浏览器导出 ChatGPT Cookie 到本地文件。在 Magpie 添加账号时选择 **导入 ChatGPT Cookie（本地文件）**，输入该文件的本机绝对路径，支持 `~/`。支持 JSON 导出，也支持保存请求头的 `.txt` 文件；输入的是文件路径。

CLI 使用同一入口：

```sh
npm run login -- --cookies "$HOME/Downloads/chatgpt.cookies.json"
npm run doctor
npm run chat -- --prompt '请只回复：Cookie 登录测试成功'
```

支持 Cookie JSON 数组和 `{"cookies": [...]}` 对象，兼容常见导出中的 `expirationDate`、`session`、`hostOnly` 和 `sameSite` 字段。也支持 `name=value; other=value` 请求头文本，可带 `Cookie:` 前缀；原样保留编码值和 `.0`、`.1` 等分段会话 Cookie，不拼接或解码。请求头没有原始域、路径、有效期属性，因此按当前 ChatGPT 主机、根路径、HTTPS 和会话有效期导入；重复名称可能属于不同路径，遇到这种情况要求使用 JSON 导出。

文件最多 1 MiB、512 条记录。JSON 只导入 `chatgpt.com` 及其子域 Cookie，忽略其他网站和已过期记录；本入口不导入 localStorage 或 IndexedDB。JSON 导出保留的信息更完整。

每次导入创建新的账号 profile，在打开网页之前安装 Cookie；账号身份和聊天输入框验证通过后才保存关联，不因匿名输入框可用就判定登录成功。若网页要求补充登录或验证，请在专用窗口中处理。导入无效、没有 ChatGPT Cookie 或全部过期时给出明确错误。

账号页可能通过 `client-bootstrap` 提供会话身份，插件在旧会话接口不可用时读取这些页面信息，只提取身份摘要和显示名称。访问出现“请稍候…”浏览器验证页时，返回 `browser_verification_required`，不将此错误当成账号过期，也不自动重发已提交消息。

Cookie 文件由本机 worker 读取，内容和源文件路径不写入 Magpie 账号存储，也不输出到日志。之后使用浏览器保存的会话，不重新读取导出文件。导出文件仍是凭据，应保存在仓库之外；会话 Cookie 是否跨重启保留取决于浏览器行为，插件保留原有过期属性，不人为延长有效期。

## 配置

Magpie Plugins → Options 使用 JSON。CLI 可保存到一个本地文件，再通过 `--options /absolute/path/options.json` 使用。

```json
{
  "browserMode": "keep-open",
  "headless": false,
  "timeoutMs": 180000,
  "idleTimeoutMs": 60000,
  "maxPromptChars": 80000
}
```

如果使用已安装 Chrome，可加入 `"channel": "chrome"`；Edge 是 `"msedge"`。使用自定义 Chromium 则设置 `"executablePath": "/absolute/path/to/browser"`。`channel` 与 `executablePath` 二选一。安装 Playwright Chromium 后两者都可留空。

代理通过 `"proxy": "http://127.0.0.1:7890"` 显式设置，支持 HTTP/HTTPS/SOCKS5 的无账号密码 URL。浏览器不会自动继承 Magpie 的全局/账号代理。改变浏览器或代理选项后重启插件；同一机器上共享 profiles 目录的多个 worker 以 profile 文件锁串行，冲突返回 `account_busy`；异常退出的锁等待 30 秒后可恢复。请使用本机文件系统，不将同一 profiles 卷共享给独立服务器。

默认只有 `web-current`：使用网页当前选择，**不保证某个模型版本**。真实账号验证后可添加精确菜单项：

```json
{
  "models": [
    {"id": "web-current", "label": "ChatGPT Web · 当前网页模型"},
    {"id": "my-web-model", "label": "我的网页模型", "pickerLabel": "网页菜单里的完整可访问名称"}
  ]
}
```

模型菜单项需精确匹配并能在主菜单找到；网页选择无法确认时返回错误，不悄悄切换模型。自动发现所有模型、嵌套菜单、思考档位暂未验证。

## 功能与限制

正在开发浏览器与内部接口混合路径。可设置 `"internalReader": true`，在网页回复停滞时尝试通过同一浏览器读取已提交轮次的内部对话数据；仅接受唯一匹配且明确完成的纯文本回复，不重新发送消息，默认关闭。实验选项 `"internalSender": true` 配合模型项的明确 `backendSlug`，只在网页发送按钮不存在时尝试内部接口；预检要求挑战时不提交消息，只有尚未尝试 POST 才允许刷新网页后恢复发送。POST 后超时、格式变化或部分回复都报错，不重发。内部发送目前只支持完整消息 SSE 格式，回复缓冲至完成后返回。内部接口可能变化，两条路径均未验证真实账号兼容性，Docker/Cloudflare 完整部署也未验证。[混合方案](docs/hybrid-plan.md) · [Docker 远程登录候选部署](docs/docker.md)。

| 功能 | 第一版行为 |
| --- | --- |
| 文本 | 内部提供 Chat Completions；Magpie 承担其他客户端协议转换 |
| 流式 / 非流式 | 段落、代码块级稳定 Markdown 增量 / 等待完整文本 |
| 多轮 | 每次新网页对话，按 JSON 传入完整历史；没有网页会话复用 |
| system / developer | 作为网页提示表达，不等同 API 原生优先级 |
| 取消、超时、限流 | 尽力停止生成，明确错误；不把部分输出标为成功 |
| 多账号 | 每次登录独立 profile；Magpie 调度，每账号串行 |
| 匿名 | 无需账号；独立持久 profile；可用性和限制由网页决定 |
| Cookie 登录 | 本地 JSON / 请求头文本导入独立账号 profile；验证账号后使用 |
| max_tokens | 仅作为近似长度提示，不是硬 token 上限 |
| temperature / top_p | 只接受默认 1；其他值拒绝 |
| 工具、图片、附件、结构化输出 | 不支持；提交网页前返回 400 |
| token usage、额度、自动模型发现 | 暂不提供，不伪造计数或套餐能力 |

短回复或只有一个段落的回复可能在完成后才输出。长回复按已稳定的段落和代码块逐块输出，不宣称原始 token 级流式。网页模式、登录挑战和页面结构可能随时变化。

请求会建立新的网页聊天，可能保留在 ChatGPT 历史中；插件不自动删除这些远端对话。网页内置工具和网页个性化设置可能影响回答。

## 账号状态和清理

网页 Cookie 留在插件专用 Chromium profile 中；Magpie 只保存 `browser:<UUID>` 本地关联和显示名称。私有 worker 管道不输出完整 session、Cookie 或 Access Token。

默认 profile 位置：

- macOS：`~/Library/Application Support/magpie-chatgptweb2api/profiles/`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/magpie-chatgptweb2api/profiles/`
- Windows：`%LOCALAPPDATA%\magpie-chatgptweb2api\profiles\`

可用 `profilesDir` 自定义独立目录。浏览器配置文件包含登录状态，应按凭据保护。保持窗口模式下，退出 Magpie 或 CLI、空闲回收只断开连接，浏览器由用户手动关闭；managed 模式才会关闭浏览器。磁盘登录会话保留，但能否跨重启继续登录取决于上游和浏览器。

Magpie 移除账号或卸载插件不会自动删除这些 profile。清理时先关闭 CLI、插件和所选 profile 的专用浏览器窗口，再删除所选 UUID 目录；清除所有网页登录会话可删除整个插件专用 profiles 目录。CLI 的账号关联保存在该目录下的 `cli-profile.json`，不是网页 Cookie。

本项目非官方，与 OpenAI 无关联。使用 ChatGPT 网页自动化时请自行评估其服务条款与账号限制。

## 开发验证

```sh
npm run check
npm test
npm run test:magpie
npm pack --dry-run
```

测试使用真实 Chromium 和本机模拟网页，不读取个人浏览器或 Magpie 账号。Bun 宿主测试默认从相邻 `../magpie` 仓库读取原版 `host.js`；可通过 `MAGPIE_SOURCE` 指定源码目录，通过 `MAGPIE_BUN` 指定 Bun。测试找不到所需依赖会报错，不默默跳过。

[设计与边界](docs/design.md) · [验证记录](docs/verification.md) · [MIT License](LICENSE)
