#!/usr/bin/env node
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BrowserBridge } from "./bridge.js";
import { parseOptions } from "./options.js";
import { prepare } from "./protocol.js";
import { publicError, WebError } from "./errors.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  options: { type: "string" }, profile: { type: "string" }, model: { type: "string", default: "web-current" },
  prompt: { type: "string" }, "prompt-file": { type: "string" },
  cookies: { type: "string" },
} });
const options = parseOptions(values.options ? JSON.parse(await readFile(values.options, "utf8")) : {});
const bridge = new BrowserBridge(options);
const ctl = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => ctl.abort());
try {
  const command = positionals[0] ?? "help";
  if (values.cookies !== undefined && command !== "login") throw new WebError("--cookies is only supported with login", 400, "invalid_command");
  const selectedFile = join(options.profilesDir, "cli-profile.json");
  if (command === "login" || command === "guest") {
    const guest = command === "guest";
    const imported = values.cookies !== undefined;
    if (values.profile && (guest || imported)) throw new WebError("--profile login cannot be combined with guest or Cookie import", 400, "invalid_command");
    const { profileId } = await bridge.call<{ profileId: string }>(guest ? "guestBegin" : imported ? "cookieBegin" : "loginBegin", imported ? { file: values.cookies } : values.profile ? { profileId: values.profile } : {}, ctl.signal);
    process.stderr.write(guest ? "已打开匿名 ChatGPT 浏览器，正在验证聊天输入框。\n" : imported ? "Cookie 已导入专用浏览器，正在验证账号。若网页要求登录或验证，请在该窗口处理。\n" : "正在连接专用浏览器。请登录 ChatGPT；程序完成后，保持窗口模式会保留窗口。\n");
    process.stderr.write(`专用 profile: ${profileId}\n`);
    if (options.remoteLoginUrl) process.stderr.write(`远程专用浏览器：${options.remoteLoginUrl}（需预先配置访问保护）\n`);
    const result = await bridge.call<{ accountId?: string }>(guest ? "guestWait" : "loginWait", { profileId }, ctl.signal);
    await mkdir(options.profilesDir, { recursive: true, mode: 0o700 });
    try { if ((await lstat(selectedFile)).isSymbolicLink()) throw new WebError("CLI profile marker must not be a symlink", 400, "invalid_profile"); } catch (e) { if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e; }
    await writeFile(selectedFile, JSON.stringify({ profileId }), { mode: 0o600 });
    process.stderr.write(`${guest ? "匿名会话已就绪" : "登录已完成"}。CLI profile: ${profileId}\n`);
    if (result.accountId && !guest) process.stderr.write("账号身份已验证，文本调用需另行测试。\n");
  } else if (command === "doctor" || command === "chat") {
    let profileId = values.profile;
    if (!profileId) {
      try { profileId = JSON.parse(await readFile(selectedFile, "utf8")).profileId; }
      catch { throw new WebError("No CLI browser profile. Run npm run guest or npm run login first, or pass --profile", 401, "sign_in_required"); }
    }
    if (!profileId) throw new WebError("Invalid CLI account marker", 401, "invalid_profile");
    if (command === "doctor") {
      const status = await bridge.call("status", { profileId }, ctl.signal);
      process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    } else {
      const prompt = values["prompt-file"] ? await readFile(values["prompt-file"], "utf8") : values.prompt ?? positionals.slice(1).join(" ");
      if (!prompt) throw new WebError("Pass --prompt or --prompt-file", 400, "missing_prompt");
      const completion = prepare(JSON.stringify({ model: values.model, messages: [{ role: "user", content: prompt }], stream: true }), options);
      const source = await bridge.open(profileId, completion, ctl.signal);
      let done = false;
      for await (const e of source) {
        if (e.event === "ready") process.stderr.write(`网页模型：${e.modelLabel}\n`);
        else if (e.event === "delta") process.stdout.write(e.text);
        else if (e.event === "done") { done = true; break; }
      }
      if (!done) throw new WebError("The webpage response did not complete", 502, "incomplete_response");
      process.stdout.write("\n");
    }
  } else {
    process.stdout.write("chatgpt-web guest|login|doctor|chat [login --cookies /absolute/path/cookies.json | login --profile UUID] [--options file.json] [--profile UUID] [--model web-current] [--prompt text | --prompt-file path]\n");
  }
} catch (e) {
  process.stderr.write(`${publicError(e).message}\n`);
  process.exitCode = 1;
} finally { await bridge.close(); }
