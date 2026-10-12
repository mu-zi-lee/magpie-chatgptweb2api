import { spawn } from "node:child_process";
import { access, constants, mkdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import lockfile from "proper-lockfile";
import { WebError } from "./errors.js";
const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const browserDir = join(packageRoot, ".playwright-browsers");
const defaultPath = chromium.executablePath();
const parts = defaultPath.split(sep);
const revisionIndex = parts.findIndex(part => /^chromium-\d+$/.test(part));
const ownedPath = revisionIndex < 0 ? undefined : join(browserDir, ...parts.slice(revisionIndex));
let pending;
async function usable(path) {
    try {
        await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function install() {
    // Explicit deployment caches are externally owned and are never modified.
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
        if (await usable(defaultPath))
            return defaultPath;
        throw new WebError("Configured Playwright cache is missing Chromium; install it or configure channel/executablePath", 503, "browser_missing");
    }
    if (!ownedPath)
        throw new WebError("Unable to determine the matching Chromium installation", 503, "browser_install_failed");
    if (await usable(ownedPath))
        return ownedPath;
    let unlock;
    try {
        await mkdir(browserDir, { recursive: true, mode: 0o700 });
        unlock = await lockfile.lock(browserDir, { lockfilePath: join(browserDir, ".install.lock"), stale: 30_000, update: 5_000, retries: 0 });
        if (await usable(ownedPath))
            return ownedPath;
        const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
        await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [cli, "install", "chromium", "--no-shell", "--no-progress"], {
                cwd: packageRoot,
                env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserDir },
                stdio: "ignore",
            });
            const timer = setTimeout(() => { child.kill(); }, 240_000);
            child.once("error", error => { clearTimeout(timer); reject(error); });
            child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("browser installer failed")); });
        });
        if (!await usable(ownedPath))
            throw new Error("browser executable missing");
        return ownedPath;
    }
    catch (error) {
        if (error.code === "ELOCKED")
            throw new WebError("Browser installation is in progress; retry shortly", 409, "browser_installing");
        throw new WebError("Automatic Chromium installation failed; check network and plugin directory permissions, or configure channel/executablePath", 503, "browser_install_failed");
    }
    finally {
        await unlock?.().catch(() => { });
    }
}
export function managedBrowserExecutable() {
    if (!pending)
        pending = install().finally(() => { pending = undefined; });
    return pending;
}
