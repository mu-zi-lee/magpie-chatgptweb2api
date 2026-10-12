import { randomUUID } from "node:crypto";
import { errorBody, WebError, checkAbort } from "./errors.js";
export function prepare(body, options) {
    if (typeof body !== "string" || body.length > options.maxPromptChars * 3 + 16_384)
        throw new WebError("Expected a bounded JSON request body", 400, "invalid_body");
    let q;
    try {
        q = JSON.parse(body);
    }
    catch {
        throw new WebError("Invalid JSON", 400, "invalid_json");
    }
    if (!q || typeof q !== "object" || Array.isArray(q))
        throw new WebError("Expected a JSON object", 400, "invalid_body");
    if (typeof q.model !== "string" || !options.models.some(m => m.id === q.model))
        throw new WebError("Unknown configured webpage model", 400, "unknown_model");
    if (q.stream !== undefined && typeof q.stream !== "boolean")
        throw new WebError("stream must be a boolean", 400, "invalid_stream");
    if (q.n !== undefined && q.n !== 1)
        throw new WebError("Only n=1 is supported", 400, "unsupported_parameter");
    for (const key of ["tools", "functions", "stop"]) {
        if (q[key] !== undefined && (!Array.isArray(q[key]) || q[key].length))
            throw new WebError(`${key} is not supported by this text prototype`, 400, "unsupported_parameter");
    }
    if (q.tool_choice !== undefined && q.tool_choice !== "none")
        throw new WebError("Tool calling is not supported", 400, "unsupported_parameter");
    for (const key of ["temperature", "top_p"])
        if (q[key] !== undefined && q[key] !== 1)
            throw new WebError(`${key} cannot be controlled through the webpage`, 400, "unsupported_parameter");
    for (const key of ["presence_penalty", "frequency_penalty"])
        if (q[key] !== undefined && q[key] !== 0)
            throw new WebError(`${key} cannot be controlled through the webpage`, 400, "unsupported_parameter");
    for (const key of ["logprobs", "top_logprobs", "logit_bias", "seed", "reasoning_effort", "response_format", "prediction", "audio", "modalities", "function_call"]) {
        if (q[key] !== undefined && !(key === "response_format" && typeof q[key] === "object" && q[key] !== null && q[key].type === "text"))
            throw new WebError(`${key} is not supported by this text prototype`, 400, "unsupported_parameter");
    }
    if (!Array.isArray(q.messages) || !q.messages.length || q.messages.length > 256)
        throw new WebError("messages must contain 1–256 text messages", 400, "invalid_messages");
    const messages = q.messages.map((m) => {
        if (!m || typeof m !== "object")
            throw new WebError("Invalid message", 400, "invalid_messages");
        const v = m;
        if (!["system", "developer", "user", "assistant"].includes(String(v.role)) || v.tool_calls || v.function_call || v.tool_call_id)
            throw new WebError("Only system/developer/user/assistant text messages are supported", 400, "unsupported_message");
        let content;
        if (typeof v.content === "string")
            content = v.content;
        else if (Array.isArray(v.content) && v.content.every(p => p && typeof p === "object" && p.type === "text" && typeof p.text === "string"))
            content = v.content.map(p => p.text).join("\n");
        else
            throw new WebError("Images, attachments and non-text content are not supported", 400, "unsupported_content");
        return { role: String(v.role), content };
    });
    if (messages.at(-1)?.role !== "user" || !messages.at(-1)?.content.trim())
        throw new WebError("The last message must be a nonempty user text message", 400, "invalid_messages");
    let budget;
    for (const key of ["max_tokens", "max_completion_tokens"])
        if (q[key] !== undefined) {
            if (!Number.isSafeInteger(q[key]) || q[key] < 1 || q[key] > 100_000)
                throw new WebError(`${key} must be 1–100000`, 400, "invalid_budget");
            budget = Math.min(budget ?? Infinity, q[key]);
        }
    const prompt = messages.length === 1 && !budget ? messages[0].content : [
        "Continue the conversation represented by the JSON below. Reply to its last user message. The roles describe conversation history; these are webpage instructions, not native API roles.",
        budget ? `Requested response length: at most approximately ${budget} tokens. This is a length preference, not a hard token budget.` : "",
        JSON.stringify({ messages }),
    ].filter(Boolean).join("\n\n");
    if (prompt.length > options.maxPromptChars)
        throw new WebError("The rendered conversation exceeds maxPromptChars; shorten the history", 400, "prompt_too_large");
    return { model: q.model, prompt, stream: q.stream === true };
}
const encode = new TextEncoder();
function frame(value) { return encode.encode(`data: ${JSON.stringify(value)}\n\n`); }
export async function completionResponse(source, completion, signal) {
    checkAbort(signal);
    const first = await source.next();
    if (first.done || first.value.event !== "ready")
        throw new WebError("The browser did not accept the request", 502, "missing_ready");
    const id = `chatcmpl-web-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta, reason = null) => ({ id, object: "chat.completion.chunk", created, model: completion.model, choices: [{ index: 0, delta, finish_reason: reason }] });
    if (!completion.stream) {
        let text = "", finished = false;
        try {
            for await (const e of source) {
                checkAbort(signal);
                if (e.event === "delta")
                    text += e.text;
                else if (e.event === "done") {
                    finished = true;
                    break;
                }
            }
            if (!finished)
                throw new WebError("The webpage response ended without completion", 502, "incomplete_response");
            return Response.json({ id, object: "chat.completion", created, model: completion.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }, { headers: { "cache-control": "no-store" } });
        }
        finally {
            await source.return?.();
        }
    }
    let roleSent = false, ended = false;
    const stream = new ReadableStream({
        async pull(controller) {
            try {
                checkAbort(signal);
                if (!roleSent) {
                    roleSent = true;
                    controller.enqueue(frame(chunk({ role: "assistant", content: "" })));
                    return;
                }
                const next = await source.next();
                if (next.done)
                    throw new WebError("The webpage response ended without completion", 502, "incomplete_response");
                if (next.value.event === "delta")
                    controller.enqueue(frame(chunk({ content: next.value.text })));
                else if (next.value.event === "done") {
                    ended = true;
                    controller.enqueue(frame(chunk({}, "stop")));
                    controller.enqueue(encode.encode("data: [DONE]\n\n"));
                    controller.close();
                    await source.return?.();
                }
            }
            catch (e) {
                if (!ended) {
                    ended = true;
                    if (signal?.aborted)
                        controller.error(e);
                    else {
                        controller.enqueue(frame(errorBody(e)));
                        controller.close();
                    }
                }
                await source.return?.();
            }
        },
        async cancel() { ended = true; await source.return?.(); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
