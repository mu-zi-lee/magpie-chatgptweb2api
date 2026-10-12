import type { Page } from "playwright";
import { WebError } from "./errors.js";

export interface InternalReply { text: string; complete: boolean }

// Only accept a unique direct assistant child of the exact submitted user node.
export function projectReply(payload: unknown, userId: string, maxChars: number): InternalReply | undefined {
  if (!payload || typeof payload !== "object") return;
  const mapping = (payload as { mapping?: Record<string, unknown> }).mapping;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return;
  const nodes = Object.entries(mapping);
  if (nodes.length > 4096) throw new WebError("Conversation mapping exceeds the reader limit", 502, "internal_response_too_large");
  const users = nodes.filter(([id, value]) => {
    const node = value as { message?: { id?: string; author?: { role?: string } } } | null;
    return node?.message?.author?.role === "user" && (id === userId || node.message.id === userId);
  });
  if (users.length !== 1) return;
  const children = nodes.filter(([, value]) => {
    const node = value as { parent?: string; message?: { author?: { role?: string } } } | null;
    return node?.parent === users[0]![0] && node.message?.author?.role === "assistant";
  });
  if (children.length !== 1) return;
  const message = (children[0]![1] as { message: { recipient?: string; status?: string; end_turn?: boolean; content?: { content_type?: string; parts?: unknown[] } } }).message;
  if (message.recipient && message.recipient !== "all") return;
  if (message.content?.content_type !== "text" || !Array.isArray(message.content.parts) || !message.content.parts.every(p => typeof p === "string")) return;
  const text = message.content.parts.join("\n");
  if (text.length > maxChars) throw new WebError("Internal reply exceeds maxOutputChars", 502, "output_too_large");
  if (!text.trim()) return;
  return { text, complete: message.end_turn === true && message.status === "finished_successfully" };
}

export async function readInternalReply(page: Page, userId: string, maxChars: number, expectedIdentity?: string): Promise<InternalReply | undefined> {
  const path = new URL(page.url()).pathname.match(/^\/c\/([a-zA-Z0-9-]+)$/);
  if (!path || !/^[a-zA-Z0-9-]{1,100}$/.test(userId)) return;
  const result = await page.evaluate(async ({ conversationId, userId, expectedIdentity }) => {
    let token: string | undefined;
    let sessionIdentity: unknown;
    try {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", signal: AbortSignal.timeout(5000) });
      if (response.status === 401) return { status: 401 };
      if (response.status === 429) return { status: 429 };
      if (response.ok) {
        const session = await response.json();
        if (!session.user) return { status: 401 };
        sessionIdentity = typeof session.user.id === "string" ? session.user.id : session.user.email;
        token = session.accessToken;
      }
    } catch {}
    if (!token) {
      try {
        const session = JSON.parse(document.getElementById("client-bootstrap")?.textContent ?? "{}").session;
        token = session?.accessToken;
        sessionIdentity = typeof session?.user?.id === "string" ? session.user.id : session?.user?.email;
      } catch {}
    }
    if (typeof token !== "string" || !token) return { status: 0 };
    if (expectedIdentity) {
      if (typeof sessionIdentity !== "string" || !sessionIdentity) return { status: 401 };
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionIdentity));
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== expectedIdentity) return { status: 409 };
    }
    try {
      const response = await fetch(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, {
        headers: { authorization: `Bearer ${token}` }, credentials: "same-origin", signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return { status: response.status };
      const reader = response.body?.getReader();
      if (!reader) return { status: 0 };
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); return { status: 413 }; }
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (!payload?.mapping || typeof payload.mapping !== "object" || Array.isArray(payload.mapping)) return { status: 0 };
      const nodes = Object.entries(payload.mapping) as [string, { parent?: string; message?: { id?: string; author?: { role?: string }; recipient?: string; status?: string; end_turn?: boolean; content?: { content_type?: string; parts?: unknown[] } } }][];
      if (nodes.length > 4096) return { status: 413 };
      const users = nodes.filter(([id, node]) => node?.message?.author?.role === "user" && (id === userId || node.message.id === userId));
      if (users.length !== 1) return { status: 0 };
      const children = nodes.filter(([, node]) => node?.parent === users[0]![0] && node.message?.author?.role === "assistant");
      if (children.length !== 1) return { status: 0 };
      const [id, node] = children[0]!;
      const message = node.message!;
      if (message.content?.content_type !== "text" || !Array.isArray(message.content.parts)
        || !message.content.parts.every(part => typeof part === "string")) return { status: 0 };
      // Never transport unrelated history, user content, metadata or session credentials.
      return { status: 200, payload: { mapping: {
        [users[0]![0]]: { message: { id: userId, author: { role: "user" } } },
        [id]: { parent: users[0]![0], message: { author: { role: "assistant" }, recipient: message.recipient,
          status: message.status, end_turn: message.end_turn,
          content: { content_type: message.content?.content_type, parts: message.content?.parts } } },
      } } };
    } catch { return { status: 0 }; }
  }, { conversationId: path[1]!, userId, expectedIdentity }).catch(() => ({ status: 0, payload: undefined }));
  if (result.status === 409) throw new WebError("The browser account changed during internal observation", 409, "account_changed");
  if (result.status === 401) throw new WebError("ChatGPT session expired during internal observation", 401, "sign_in_required");
  if (result.status === 429) throw new WebError("ChatGPT limited internal observation", 429, "upstream_rate_limit");
  if (result.status === 413) throw new WebError("Internal response exceeds the reader limit", 502, "internal_response_too_large");
  return result.status === 200 ? projectReply(result.payload, userId, maxChars) : undefined;
}
