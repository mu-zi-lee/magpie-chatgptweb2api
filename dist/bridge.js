import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebError, abortError, checkAbort } from "./errors.js";
class EventQueue {
    cancel;
    items = [];
    bytes = 0;
    terminal = false;
    failure;
    waiter;
    constructor(cancel) {
        this.cancel = cancel;
    }
    push(event) {
        if (this.terminal)
            return;
        if (this.waiter) {
            const w = this.waiter;
            this.waiter = undefined;
            w.resolve({ value: event, done: false });
            return;
        }
        this.bytes += event.event === "delta" ? Buffer.byteLength(event.text) : 256;
        if (this.bytes > 4 * 1024 * 1024) {
            this.fail(new WebError("The client is not consuming the browser stream", 502, "stream_buffer_full"));
            this.cancel();
            return;
        }
        this.items.push(event);
    }
    end() { this.terminal = true; if (this.waiter) {
        this.waiter.resolve({ value: undefined, done: true });
        this.waiter = undefined;
    } }
    fail(error) {
        this.failure = error;
        this.terminal = true;
        this.items = [];
        this.bytes = 0;
        if (this.waiter) {
            this.waiter.reject(error);
            this.waiter = undefined;
        }
    }
    next() {
        if (this.failure)
            return Promise.reject(this.failure);
        const item = this.items.shift();
        if (item) {
            this.bytes -= item.event === "delta" ? Buffer.byteLength(item.text) : 256;
            return Promise.resolve({ value: item, done: false });
        }
        if (this.terminal)
            return Promise.resolve({ value: undefined, done: true });
        if (this.waiter)
            return Promise.reject(new WebError("Concurrent reads from one stream are not supported"));
        return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
    }
    async return() { this.cancel(); this.items = []; this.bytes = 0; this.end(); return { value: undefined, done: true }; }
    [Symbol.asyncIterator]() { return this; }
}
export class BrowserBridge {
    options;
    site;
    child;
    starting;
    closed = false;
    nextId = 0;
    pending = new Map();
    exitHandler = () => { this.child?.stdin.destroy(); };
    constructor(options, site) {
        this.options = options;
        this.site = site;
        // The separate worker owns Chromium. Closing this private pipe also works
        // when Magpie exits synchronously, before asynchronous plugin cleanup runs.
        process.once("exit", this.exitHandler);
    }
    async start() {
        if (this.closed)
            throw new WebError("The browser bridge is closed", 503, "bridge_closed");
        if (this.starting)
            return this.starting;
        this.starting = (async () => {
            const child = spawn(process.execPath, [fileURLToPath(new URL("./worker.js", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
            this.child = child;
            let buffer = "";
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (data) => {
                buffer += data;
                if (buffer.length > 2 * 1024 * 1024) {
                    this.failAll(new WebError("Invalid browser worker output", 502, "worker_protocol_error"));
                    child.kill();
                    return;
                }
                let pos;
                while ((pos = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, pos);
                    buffer = buffer.slice(pos + 1);
                    if (!line)
                        continue;
                    try {
                        this.receive(JSON.parse(line));
                    }
                    catch {
                        this.failAll(new WebError("Invalid browser worker output", 502, "worker_protocol_error"));
                        child.kill();
                        return;
                    }
                }
            });
            // Drain diagnostics without forwarding browser/page content or credentials.
            child.stderr.resume();
            child.stdin.on("error", () => this.failAll(new WebError("Browser worker pipe closed", 502, "worker_closed")));
            child.on("error", () => this.failAll(new WebError("Unable to start browser worker", 503, "worker_start_failed")));
            child.on("exit", () => {
                this.failAll(new WebError("Browser worker exited; retry the request", 502, "worker_exited"));
                if (this.child === child) {
                    this.child = undefined;
                    this.starting = undefined;
                }
            });
            await this.rawCall("init", { options: this.options, site: this.site }, 30_000);
        })();
        try {
            await this.starting;
        }
        catch (e) {
            this.child?.kill();
            this.starting = undefined;
            throw e;
        }
    }
    send(value) {
        if (!this.child || this.child.stdin.destroyed)
            throw new WebError("Browser worker is unavailable", 503, "worker_closed");
        const data = JSON.stringify(value);
        if (Buffer.byteLength(data) > 1024 * 1024)
            throw new WebError("Browser request is too large", 400, "worker_request_too_large");
        this.child.stdin.write(data + "\n");
    }
    finish(id) { const p = this.pending.get(id); this.pending.delete(id); p?.cleanup(); }
    cancel(id) {
        if (!this.pending.has(id))
            return;
        try {
            this.send({ method: "cancel", params: { id } });
        }
        catch { }
        const p = this.pending.get(id);
        this.finish(id);
        p.reject(abortError());
    }
    failAll(error) { for (const [id, p] of this.pending) {
        this.finish(id);
        p.reject(error);
    } }
    receive(q) {
        const p = this.pending.get(q.id);
        if (!p)
            return;
        if (q.error) {
            this.finish(q.id);
            p.reject(new WebError(q.error.message, q.error.status, q.error.code));
        }
        else if (q.event) {
            if (!p.queue || !["ready", "delta", "done"].includes(q.event))
                throw new Error("invalid event");
            if (q.event === "delta" && typeof q.text !== "string")
                throw new Error("invalid delta");
            p.queue.push(q);
        }
        else if ("result" in q) {
            this.finish(q.id);
            p.resolve?.(q.result);
            p.queue?.end();
        }
        else
            throw new Error("invalid frame");
    }
    attach(id, p, timeout, signal) {
        if (this.pending.size >= 16)
            throw new WebError("Too many browser operations", 429, "bridge_busy");
        const abort = () => this.cancel(id);
        const timer = setTimeout(() => {
            try {
                this.send({ method: "cancel", params: { id } });
            }
            catch { }
            this.finish(id);
            p.reject(new WebError("The browser worker did not finish in time", 504, "worker_timeout"));
        }, timeout);
        this.pending.set(id, { ...p, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } });
        signal?.addEventListener("abort", abort, { once: true });
    }
    rawCall(method, params, timeout, signal) {
        checkAbort(signal);
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            this.attach(id, { resolve, reject }, timeout, signal);
            try {
                this.send({ id, method, params });
            }
            catch (e) {
                this.finish(id);
                reject(e);
            }
        });
    }
    async call(method, params, signal) {
        checkAbort(signal);
        await this.start();
        return await this.rawCall(method, params, method === "loginWait" ? this.options.loginTimeoutMs + 15_000 : method === "guestWait" ? 75_000 : 300_000, signal);
    }
    async open(profileId, completion, signal) {
        checkAbort(signal);
        await this.start();
        checkAbort(signal);
        const id = ++this.nextId;
        const queue = new EventQueue(() => this.cancel(id));
        this.attach(id, { queue, reject: e => queue.fail(e) }, this.options.timeoutMs + 60_000, signal);
        try {
            this.send({ id, method: "complete", params: { profileId, completion } });
        }
        catch (e) {
            this.finish(id);
            queue.fail(e);
        }
        return queue;
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        process.removeListener("exit", this.exitHandler);
        this.failAll(new WebError("The plugin is shutting down", 503, "bridge_closed"));
        const child = this.child;
        if (!child)
            return;
        await new Promise(resolve => {
            const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 8_000);
            child.once("exit", () => { clearTimeout(timer); resolve(); });
            child.stdin.end();
        });
    }
}
