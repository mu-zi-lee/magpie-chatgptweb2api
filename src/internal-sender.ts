import type { Page } from "playwright";
import { randomUUID } from "node:crypto";
import { WebError, checkAbort } from "./errors.js";

// undefined is returned only before the conversation POST. Unknown submissions throw.
export async function sendInternal(page: Page, prompt: string, model: string, timeoutMs: number, maxChars: number, signal?: AbortSignal, expectedIdentity?: string): Promise<string | undefined> {
  checkAbort(signal);
  const cancel = () => { void page.close().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let result: { code: string; text?: string };
  try {
    result = await page.evaluate(async ({ prompt, model, timeoutMs, maxChars, userId, parentId, expectedIdentity }) => {
    let attempted = false;
    try {
      const session = await fetch("/api/auth/session", { credentials: "same-origin", signal: AbortSignal.timeout(5000) });
      if (session.status === 401) return { code: "auth" };
      if (session.status === 429) return { code: "limited" };
      if (!session.ok) return { code: "unavailable" };
      const sessionData = await session.json();
      if (expectedIdentity) {
        const identity = typeof sessionData.user?.id === "string" ? sessionData.user.id : sessionData.user?.email;
        if (typeof identity !== "string" || !identity) return { code: "auth" };
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
        const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
        if (hash !== expectedIdentity) return { code: "account_changed" };
      }
      const token = sessionData.accessToken;
      if (typeof token !== "string" || !token) return { code: "unavailable" };
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const preflight = await fetch("/backend-api/sentinel/chat-requirements", { method: "POST", headers, body: "{}", credentials: "same-origin", signal: AbortSignal.timeout(5000) });
      if (preflight.status === 401) return { code: "auth" };
      if (preflight.status === 429) return { code: "limited" };
      if (!preflight.ok) return { code: "unavailable" };
      const requirements = await preflight.json();
      if (requirements.turnstile?.required || requirements.arkose?.required || requirements.proofofwork?.required || typeof requirements.token !== "string" || !requirements.token) return { code: "unavailable" };
      headers["openai-sentinel-chat-requirements-token"] = requirements.token;
      attempted = true;
      const response = await fetch("/backend-api/conversation", {
        method: "POST", headers, credentials: "same-origin", signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ action: "next", model, parent_message_id: parentId, messages: [{ id: userId, author: { role: "user" }, content: { content_type: "text", parts: [prompt] } }], history_and_training_disabled: false, force_use_sse: true }),
      });
      if (response.status === 401) return { code: "auth" };
      if (response.status === 429) return { code: "limited" };
      if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) return { code: "unknown" };
      const reader = response.body?.getReader();
      if (!reader) return { code: "unknown" };
      const decoder = new TextDecoder();
      let buffer = "", bytes = 0, text = "", assistantId = "", conversationId = "", finished = false;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 4 * 1024 * 1024) return { code: "oversized" };
          buffer += decoder.decode(next.value, { stream: true });
          buffer = buffer.replace(/\r\n/g, "\n");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data || data === "[DONE]") continue;
            const value = JSON.parse(data);
            if (!value || typeof value !== "object" || Array.isArray(value) || value.error) return { code: "unknown" };
            const message = value.message;
            // Unknown delta encodings must fail, not silently preserve a stale snapshot.
            if (!message) return { code: "unknown" };
            if (message.author?.role === "user") {
              if (message.id !== userId) return { code: "unknown" };
              continue;
            }
            if (message.author?.role !== "assistant") return { code: "unknown" };
            if (typeof message.id !== "string" || (assistantId && assistantId !== message.id)) return { code: "unknown" };
            assistantId = message.id;
            if (typeof value.conversation_id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(value.conversation_id) || (conversationId && conversationId !== value.conversation_id)) return { code: "unknown" };
            conversationId = value.conversation_id;
            if ((message.recipient && message.recipient !== "all") || message.content?.content_type !== "text" || !Array.isArray(message.content.parts) || !message.content.parts.every((p: unknown) => typeof p === "string")) return { code: "unknown" };
            text = message.content.parts.join("\n");
            if (text.length > maxChars) return { code: "oversized" };
            finished = message.end_turn === true && message.status === "finished_successfully";
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) return { code: "unknown" };
        return finished && text.trim() && conversationId ? { code: "done", text } : { code: "unknown" };
      } finally { await reader.cancel().catch(() => {}); }
    } catch { return { code: attempted ? "unknown" : "unavailable" }; }
    }, { prompt, model, timeoutMs, maxChars, expectedIdentity, userId: randomUUID(), parentId: randomUUID() }).catch(() => ({ code: "unknown", text: undefined }));
  } finally { signal?.removeEventListener("abort", cancel); }
  checkAbort(signal);
  if (result.code === "unavailable") return;
  if (result.code === "auth") throw new WebError("Internal interface requires sign-in", 401, "sign_in_required");
  if (result.code === "account_changed") throw new WebError("The browser account changed before internal submission", 409, "account_changed");
  if (result.code === "limited") throw new WebError("Internal interface reported a rate limit", 429, "upstream_rate_limit");
  if (result.code === "oversized") throw new WebError("Internal response exceeds its bounded limit; no resend attempted", 502, "internal_response_too_large");
  if (result.code !== "done" || !result.text) throw new WebError("Internal submission did not produce a verified complete reply; no resend attempted", 502, "internal_submission_unknown");
  return result.text;
}
