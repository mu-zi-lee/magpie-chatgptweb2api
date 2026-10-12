import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { SITE_URL } from "./options.js";
import { WebError } from "./errors.js";
const MAX_BYTES = 1024 * 1024;
const invalid = () => new WebError("Invalid Cookie file; use a JSON cookie export or a name=value Cookie request header", 400, "invalid_cookie_file");
export function cookieFilePath(input) {
    if (typeof input !== "string" || !input.trim() || input.includes("\0"))
        throw new WebError("Enter the local Cookie file's absolute path", 400, "cookie_file_required");
    const file = input.trim();
    if (file.startsWith("~/") || file.startsWith("~\\"))
        return join(homedir(), file.slice(2));
    if (!isAbsolute(file))
        throw new WebError("Cookie file must use an absolute path or ~/", 400, "cookie_file_required");
    return file;
}
// Only normalized cookie fields reach Chromium. Exporter metadata and cookies
// for other websites are discarded; neither values nor parser errors are logged.
export function normalizeCookies(input, site = SITE_URL, now = Date.now() / 1000) {
    const items = Array.isArray(input) ? input : input && typeof input === "object" ? input.cookies : undefined;
    if (!Array.isArray(items) || !items.length || items.length > 512)
        throw invalid();
    const origin = new URL(site);
    const hostname = origin.hostname;
    const result = [];
    for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item))
            throw invalid();
        const c = item;
        let domain;
        let path;
        if (typeof c.domain === "string") {
            domain = c.domain.toLowerCase();
            const bare = domain.replace(/^\./, "");
            if (bare !== hostname && !(hostname === "chatgpt.com" && bare.endsWith(".chatgpt.com")))
                continue;
            if (typeof c.path !== "string" || !c.path.startsWith("/") || /[\r\n\0]/.test(c.path))
                throw invalid();
            path = c.path;
            if (c.hostOnly === true)
                domain = bare;
        }
        else if (typeof c.url === "string") {
            let url;
            try {
                url = new URL(c.url);
            }
            catch {
                throw invalid();
            }
            if (url.origin !== origin.origin || url.username || url.password)
                continue;
            domain = hostname;
            path = typeof c.path === "string" ? c.path : "/";
            if (!path.startsWith("/") || /[\r\n\0]/.test(path))
                throw invalid();
        }
        else {
            throw invalid();
        }
        if (typeof c.name !== "string" || !c.name || c.name.length > 256 || /[\s;=\0]/.test(c.name)
            || typeof c.value !== "string" || c.value.length > 16_384 || /[\r\n\0]/.test(c.value))
            throw invalid();
        for (const key of ["httpOnly", "secure", "session", "hostOnly"])
            if (c[key] !== undefined && typeof c[key] !== "boolean")
                throw invalid();
        const cookie = { name: c.name, value: c.value, domain, path };
        for (const key of ["httpOnly", "secure"])
            if (typeof c[key] === "boolean")
                cookie[key] = c[key];
        const expires = c.expires ?? c.expirationDate;
        if (expires !== undefined) {
            if (typeof expires !== "number" || !Number.isFinite(expires) || expires < -1)
                throw invalid();
            if (c.session !== true && expires !== -1) {
                if (expires <= now)
                    continue;
                cookie.expires = expires;
            }
        }
        if (c.sameSite !== undefined) {
            if (typeof c.sameSite !== "string")
                throw invalid();
            const sameSite = c.sameSite.toLowerCase();
            if (sameSite === "strict")
                cookie.sameSite = "Strict";
            else if (sameSite === "lax")
                cookie.sameSite = "Lax";
            else if (sameSite === "none" || sameSite === "no_restriction")
                cookie.sameSite = "None";
            else if (sameSite !== "unspecified")
                throw invalid();
        }
        if (c.partitionKey !== undefined) {
            if (typeof c.partitionKey !== "string" || c.partitionKey !== origin.origin)
                throw invalid();
            cookie.partitionKey = c.partitionKey;
        }
        result.push(cookie);
    }
    if (!result.length)
        throw new WebError("No unexpired ChatGPT cookies found in the file", 400, "cookie_file_empty");
    return result;
}
export function parseCookieHeader(input, site = SITE_URL) {
    const header = input.trim().replace(/^cookie:\s*/i, "");
    if (!header || /[\r\n\0]/.test(header))
        throw invalid();
    const origin = new URL(site);
    const parts = header.split(";").map(part => part.trim()).filter(Boolean);
    if (!parts.length || parts.length > 512)
        throw invalid();
    const names = new Set();
    const cookies = parts.map(part => {
        const separator = part.indexOf("=");
        if (separator < 1)
            throw invalid();
        const name = part.slice(0, separator).trim();
        if (names.has(name))
            throw new WebError("Duplicate Cookie names are ambiguous in request-header exports; use JSON instead", 400, "invalid_cookie_file");
        names.add(name);
        // Headers have no Domain/Path/Expires attributes. Use the current host,
        // root path and session lifetime; preserve values and split token chunks.
        return { name, value: part.slice(separator + 1).trim(), domain: origin.hostname, path: "/", secure: origin.protocol === "https:",
            httpOnly: /^__(?:Host|Secure)-next-auth\./.test(name) };
    });
    return normalizeCookies(cookies, site);
}
export async function readCookieFile(input, site = SITE_URL) {
    const path = cookieFilePath(input);
    let contents;
    try {
        // O_NONBLOCK prevents a mistakenly selected FIFO from hanging the worker.
        const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > MAX_BYTES)
                throw new WebError("Cookie file must be a regular file no larger than 1 MiB", 400, "invalid_cookie_file");
            // Bound the read even if the file grows after stat().
            contents = Buffer.alloc(MAX_BYTES + 1);
            let size = 0;
            while (size < contents.length) {
                const { bytesRead } = await file.read(contents, size, contents.length - size, null);
                if (!bytesRead)
                    break;
                size += bytesRead;
            }
            if (size > MAX_BYTES)
                throw new WebError("Cookie file is larger than 1 MiB", 400, "invalid_cookie_file");
            contents = contents.subarray(0, size);
        }
        finally {
            await file.close();
        }
    }
    catch (e) {
        if (e instanceof WebError)
            throw e;
        throw new WebError("Unable to read the local Cookie file; check its path and permissions", 400, "cookie_file_unreadable");
    }
    const text = contents.toString("utf8").replace(/^\uFEFF/, "").trim();
    if (!text.startsWith("[") && !text.startsWith("{"))
        return parseCookieHeader(text, site);
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw invalid();
    }
    return normalizeCookies(parsed, site);
}
