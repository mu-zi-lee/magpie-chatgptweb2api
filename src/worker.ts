import { createInterface } from "node:readline";
import { once } from "node:events";
import { BrowserRuntime } from "./browser.js";
import { parseOptions } from "./options.js";
import { publicError, WebError } from "./errors.js";
import { type Completion } from "./protocol.js";

let runtime: BrowserRuntime | undefined;
let closing = false;
const pending = new Map<number, AbortController>();
const input = createInterface({ input: process.stdin, terminal: false });

async function send(value: unknown): Promise<void> {
  if (closing || process.stdout.destroyed) return;
  if (!process.stdout.write(JSON.stringify(value) + "\n")) await once(process.stdout, "drain");
}

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  for (const c of pending.values()) c.abort();
  input.close();
  await runtime?.close();
  process.stdin.destroy();
}

input.on("line", line => {
  if (closing) return;
  if (line.length > 2 * 1024 * 1024) { void shutdown(); return; }
  let q: { id?: number; method?: string; params?: Record<string, unknown> };
  try { q = JSON.parse(line); } catch { void shutdown(); return; }
  if (q.method === "cancel") { pending.get(q.params?.id as number)?.abort(); return; }
  if (!Number.isSafeInteger(q.id) || typeof q.method !== "string") return;
  const id = q.id!;
  if (pending.has(id) || pending.size >= 16) { void send({ id, error: { status: 429, code: "worker_busy", message: "The browser worker is busy" } }); return; }
  const ctl = new AbortController();
  pending.set(id, ctl);
  void (async () => {
    try {
      const p = q.params ?? {};
      if (q.method === "init") {
        if (runtime) throw new WebError("Worker already initialized", 400, "already_initialized");
        runtime = new BrowserRuntime(parseOptions(p.options), p.site as string | undefined);
        await send({ id, result: null });
        return;
      }
      if (!runtime) throw new WebError("Worker is not initialized", 503, "not_initialized");
      let result: unknown;
      switch (q.method) {
        case "loginBegin": result = await runtime.beginLogin(ctl.signal, p.profileId === undefined ? undefined : String(p.profileId)); break;
        case "cookieBegin": result = await runtime.beginCookieLogin(p.file, ctl.signal); break;
        case "loginWait": result = await runtime.waitLogin(String(p.profileId), ctl.signal); break;
        case "guestBegin": result = await runtime.beginGuest(ctl.signal); break;
        case "guestWait": result = await runtime.waitGuest(String(p.profileId), ctl.signal); break;
        case "status": result = await runtime.status(String(p.profileId), ctl.signal); break;
        case "complete":
          for await (const event of runtime.complete(String(p.profileId), p.completion as Completion, ctl.signal)) await send({ id, ...event });
          break;
        default: throw new WebError("Unknown worker method", 400, "unknown_method");
      }
      await send({ id, result: result ?? null });
    } catch (error) {
      const e = publicError(error);
      await send({ id, error: { message: e.message, status: e.status, code: e.code } }).catch(() => {});
    } finally { pending.delete(id); }
  })();
});

input.on("close", () => { void shutdown(); });
process.stdout.on("error", () => { void shutdown(); });
process.stdin.on("error", () => { void shutdown(); });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void shutdown(); });
