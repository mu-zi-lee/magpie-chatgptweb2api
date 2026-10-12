import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { WebError } from "./errors.js";
export const PROVIDER = "chatgpt-web";
export const BASE_URL = "https://chatgpt-web.invalid/v1";
export const SITE_URL = "https://chatgpt.com/";
function integer(o, key, fallback, min, max) {
    const v = o[key] ?? fallback;
    if (!Number.isSafeInteger(v) || v < min || v > max) {
        throw new WebError(`${key} must be an integer from ${min} to ${max}`, 400, "invalid_options");
    }
    return v;
}
export function defaultProfilesDir() {
    if (process.platform === "darwin")
        return join(homedir(), "Library", "Application Support", "magpie-chatgptweb2api", "profiles");
    if (process.platform === "win32")
        return join(process.env.LOCALAPPDATA || homedir(), "magpie-chatgptweb2api", "profiles");
    return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "magpie-chatgptweb2api", "profiles");
}
export function parseOptions(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new WebError("Plugin options must be an object", 400, "invalid_options");
    const o = input;
    const known = new Set(["internalReader", "browserMode", "profilesDir", "executablePath", "channel", "proxy", "headless", "timeoutMs", "loginTimeoutMs", "idleTimeoutMs", "pollMs", "settleMs", "maxPromptChars", "maxOutputChars", "contextLimit", "outputLimit", "models"]);
    known.add("internalSender");
    known.add("remoteLoginUrl");
    for (const k of Object.keys(o))
        if (!known.has(k))
            throw new WebError(`Unknown plugin option: ${k}`, 400, "invalid_options");
    for (const k of ["profilesDir", "executablePath", "proxy"])
        if (o[k] !== undefined && (typeof o[k] !== "string" || !o[k].trim()))
            throw new WebError(`${k} must be a nonempty string`, 400, "invalid_options");
    if (o.browserMode !== undefined && !["keep-open", "managed"].includes(o.browserMode))
        throw new WebError("browserMode must be keep-open or managed", 400, "invalid_options");
    if (o.headless !== undefined && typeof o.headless !== "boolean")
        throw new WebError("headless must be a boolean", 400, "invalid_options");
    if (o.internalReader !== undefined && typeof o.internalReader !== "boolean")
        throw new WebError("internalReader must be a boolean", 400, "invalid_options");
    if (o.internalSender !== undefined && typeof o.internalSender !== "boolean")
        throw new WebError("internalSender must be a boolean", 400, "invalid_options");
    if (o.remoteLoginUrl !== undefined) {
        let remote;
        try {
            remote = new URL(String(o.remoteLoginUrl));
        }
        catch {
            throw new WebError("remoteLoginUrl must be a protected HTTPS URL", 400, "invalid_options");
        }
        if (typeof o.remoteLoginUrl !== "string" || remote.protocol !== "https:" || !remote.href.startsWith(`https://${remote.host}/`) || remote.search || remote.hash)
            throw new WebError("remoteLoginUrl must use HTTPS without credentials, query or fragment", 400, "invalid_options");
    }
    if (o.channel !== undefined && o.channel !== "chrome" && o.channel !== "msedge")
        throw new WebError("channel must be chrome or msedge", 400, "invalid_options");
    if (o.channel && o.executablePath)
        throw new WebError("Choose channel or executablePath", 400, "invalid_options");
    if (o.proxy) {
        let u;
        try {
            u = new URL(o.proxy);
        }
        catch {
            throw new WebError("proxy must be a valid URL", 400, "invalid_options");
        }
        if (!["http:", "https:", "socks5:"].includes(u.protocol) || u.username || u.password || (u.pathname !== "/" && u.pathname) || u.search || u.hash)
            throw new WebError("proxy must be an HTTP, HTTPS or SOCKS5 URL without credentials or a path", 400, "invalid_options");
    }
    const models = o.models ?? [{ id: "web-current", label: "ChatGPT Web · 当前网页模型" }];
    if (!Array.isArray(models) || models.length < 1 || models.length > 32)
        throw new WebError("models must contain 1–32 entries", 400, "invalid_options");
    const seen = new Set();
    const validated = models.map(m => {
        if (!m || typeof m !== "object" || typeof m.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(m.id) || typeof m.label !== "string" || !m.label.trim() || m.label.length > 200 || (m.pickerLabel !== undefined && (typeof m.pickerLabel !== "string" || !m.pickerLabel.trim() || m.pickerLabel.length > 200)))
            throw new WebError("Each model needs id, label and optional exact pickerLabel", 400, "invalid_options");
        if (seen.has(m.id))
            throw new WebError("Model ids must be unique", 400, "invalid_options");
        if (m.backendSlug !== undefined && (typeof m.backendSlug !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(m.backendSlug)))
            throw new WebError("backendSlug must be an explicit internal model identifier", 400, "invalid_options");
        seen.add(m.id);
        return { id: m.id, label: m.label, ...(m.pickerLabel ? { pickerLabel: m.pickerLabel } : {}), ...(m.backendSlug ? { backendSlug: m.backendSlug } : {}) };
    });
    return {
        profilesDir: resolve(o.profilesDir ?? defaultProfilesDir()),
        executablePath: o.executablePath,
        channel: o.channel,
        proxy: o.proxy,
        browserMode: o.browserMode ?? "keep-open",
        headless: o.headless ?? false,
        internalReader: o.internalReader ?? false,
        internalSender: o.internalSender ?? false,
        remoteLoginUrl: o.remoteLoginUrl,
        timeoutMs: integer(o, "timeoutMs", 180_000, 1_000, 1_800_000),
        loginTimeoutMs: integer(o, "loginTimeoutMs", 300_000, 1_000, 900_000),
        idleTimeoutMs: integer(o, "idleTimeoutMs", 60_000, 1_000, 600_000),
        pollMs: integer(o, "pollMs", 250, 50, 2_000),
        settleMs: integer(o, "settleMs", 1_000, 100, 10_000),
        maxPromptChars: integer(o, "maxPromptChars", 80_000, 100, 500_000),
        maxOutputChars: integer(o, "maxOutputChars", 500_000, 100, 1_000_000),
        contextLimit: integer(o, "contextLimit", 16_384, 1, 200_000),
        outputLimit: integer(o, "outputLimit", 4_096, 1, 100_000),
        models: validated,
    };
}
