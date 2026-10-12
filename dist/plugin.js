import { BrowserBridge } from "./bridge.js";
import { BASE_URL, PROVIDER, parseOptions } from "./options.js";
import { completionResponse, prepare } from "./protocol.js";
import { WebError, errorBody, publicError, checkAbort } from "./errors.js";
import { cookieFilePath } from "./cookies.js";
function profileOf(auth) {
    if (auth?.type !== "api" || !auth.key?.startsWith("browser:"))
        throw new WebError("Sign in using the ChatGPT Web browser method", 401, "sign_in_required");
    const id = auth.key.slice("browser:".length);
    if (!/^[0-9a-f-]{36}$/.test(id))
        throw new WebError("Invalid browser account association; sign in again", 401, "invalid_profile");
    return id;
}
function modelList(options) {
    return Object.fromEntries(options.models.map(m => [m.id, {
            id: m.id, name: m.label, api: { id: m.id, url: BASE_URL, npm: "@ai-sdk/openai-compatible" },
            limit: { context: options.contextLimit, output: options.outputLimit },
            capabilities: { reasoning: false, toolcall: false, attachment: false, input: { text: true, image: false }, output: { text: true } },
        }]));
}
export function createPluginHooks(input = {}, runtime) {
    const options = parseOptions(input);
    const bridge = runtime ?? new BrowserBridge(options);
    const remoteInstructions = options.remoteLoginUrl ? ` 远程专用浏览器：${options.remoteLoginUrl}（需预先配置访问保护）。` : "";
    const close = () => { void bridge.close(); };
    process.stdin.once("end", close);
    return {
        config: async (cfg) => {
            cfg.provider ??= {};
            cfg.provider[PROVIDER] = { name: "ChatGPT Web", npm: "@ai-sdk/openai-compatible", api: BASE_URL, models: modelList(options) };
        },
        auth: {
            provider: PROVIDER,
            maxConcurrency: 1,
            methods: [{
                    type: "oauth", label: "手动登录 ChatGPT（推荐）",
                    async authorize() {
                        const { profileId } = await bridge.call("loginBegin", {});
                        return {
                            url: "", method: "auto",
                            instructions: `请在专用浏览器中手动登录 ChatGPT，密码、验证码和 Google 登录都在网页完成。确认账号和输入框后会保存关联；保持窗口模式会保留窗口，后续请求使用独立标签页。账号已登录不代表文本调用已验证。专用 profile: ${profileId}${remoteInstructions}`,
                            async callback() {
                                try {
                                    const status = await bridge.call("loginWait", { profileId });
                                    if (!status.authenticated)
                                        return { type: "failed", error: "ChatGPT 登录尚未完成" };
                                    // Magpie stores an opaque local profile association, not a web token.
                                    return { type: "success", key: `browser:${profileId}`, metadata: { profileId, email: status.accountId } };
                                }
                                catch (e) {
                                    return { type: "failed", error: publicError(e).message };
                                }
                            },
                        };
                    },
                }, {
                    type: "oauth", label: "匿名网页会话（无需登录）",
                    async authorize() {
                        const { profileId } = await bridge.call("guestBegin", {});
                        return {
                            url: "", method: "auto",
                            instructions: "正在验证匿名网页聊天。无需登录；若网页要求验证，请在插件浏览器中处理。" + remoteInstructions,
                            async callback() {
                                try {
                                    const status = await bridge.call("guestWait", { profileId });
                                    if (!status.ready)
                                        return { type: "failed", error: "匿名聊天尚不可用" };
                                    return { type: "success", key: `browser:${profileId}`, metadata: { profileId, email: "匿名网页", mode: "guest" } };
                                }
                                catch (e) {
                                    return { type: "failed", error: publicError(e).message };
                                }
                            },
                        };
                    },
                }, {
                    type: "oauth", label: "导入 ChatGPT Cookie（本地文件）",
                    prompts: [{
                            type: "text", key: "cookieFile", message: "Cookie 文件的本机绝对路径（JSON 或请求头文本）",
                            placeholder: "~/Downloads/chatgpt.cookies.json",
                            validate(value) {
                                try {
                                    cookieFilePath(value);
                                    return undefined;
                                }
                                catch (e) {
                                    return publicError(e).message;
                                }
                            },
                        }],
                    async authorize(inputs = {}) {
                        const file = cookieFilePath(inputs.cookieFile);
                        const { profileId } = await bridge.call("cookieBegin", { file });
                        return {
                            url: "", method: "auto",
                            instructions: "Cookie 已导入专用浏览器，正在验证账号。若网页要求登录或验证，请在该窗口处理；确认账号和聊天输入框后才保存关联。" + remoteInstructions,
                            async callback() {
                                try {
                                    const status = await bridge.call("loginWait", { profileId });
                                    if (!status.authenticated)
                                        return { type: "failed", error: "Cookie 尚未恢复有效账号会话" };
                                    return { type: "success", key: `browser:${profileId}`, metadata: { profileId, email: status.accountId, mode: "cookie" } };
                                }
                                catch (e) {
                                    return { type: "failed", error: publicError(e).message };
                                }
                            },
                        };
                    },
                }, {
                    type: "oauth", label: "继续已有浏览器登录",
                    prompts: [{
                            type: "text", key: "profileId", message: "之前登录提示中的专用 profile UUID",
                            validate(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value?.trim()) ? undefined : "请输入有效的专用 profile UUID"; },
                        }],
                    async authorize(inputs = {}) {
                        const { profileId } = await bridge.call("loginBegin", { profileId: inputs.profileId?.trim() ?? "" });
                        return {
                            url: "", method: "auto",
                            instructions: `正在继续同一个专用浏览器。请完成网页登录或验证；不会新建账号目录。专用 profile: ${profileId}${remoteInstructions}`,
                            async callback() {
                                try {
                                    const status = await bridge.call("loginWait", { profileId });
                                    if (!status.authenticated)
                                        return { type: "failed", error: "ChatGPT 登录尚未完成" };
                                    return { type: "success", key: `browser:${profileId}`, metadata: { profileId, email: status.accountId } };
                                }
                                catch (e) {
                                    return { type: "failed", error: publicError(e).message };
                                }
                            },
                        };
                    },
                }],
            async loader(getAuth) {
                return {
                    baseURL: BASE_URL, apiKey: "managed-browser-session",
                    async fetch(url, init = {}) {
                        let source;
                        try {
                            checkAbort(init.signal ?? undefined);
                            const target = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
                            if (target.pathname !== "/v1/chat/completions" || (init.method ?? "POST").toUpperCase() !== "POST")
                                throw new WebError("This provider serves Chat Completions; Magpie handles client protocol conversion", 400, "unsupported_endpoint");
                            const completion = prepare(init.body, options);
                            const profileId = profileOf(await getAuth());
                            source = await bridge.open(profileId, completion, init.signal ?? undefined);
                            return await completionResponse(source, completion, init.signal ?? undefined);
                        }
                        catch (e) {
                            await source?.return?.();
                            if (init.signal?.aborted)
                                throw init.signal.reason ?? e;
                            const error = publicError(e);
                            const headers = { "cache-control": "no-store" };
                            if (error.status === 401)
                                headers["x-magpie-sign-in"] = "expired";
                            if (error.status === 429)
                                headers["retry-after"] = "5";
                            return Response.json(errorBody(error), { status: error.status, headers });
                        }
                    },
                };
            },
            async usage(getAuth) {
                try {
                    const status = await bridge.call("status", { profileId: profileOf(await getAuth()) });
                    return { plan: status.anonymous ? "ChatGPT Web 匿名会话" : "ChatGPT Web 浏览器会话", user: status.accountId, message: status.modelLabel ? `网页当前模型：${status.modelLabel}` : "网页会话可用；额度尚未查询" };
                }
                catch (e) {
                    const error = publicError(e);
                    return { error: error.message, signIn: error.status === 401 ? "expired" : "kept" };
                }
            },
        },
        provider: { id: PROVIDER, async models() { return modelList(options); } },
    };
}
