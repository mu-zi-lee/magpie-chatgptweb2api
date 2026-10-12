import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { WebError } from "./errors.js";

const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
converter.use(gfm);
// The lightweight DIL renderer puts the language in a sibling label rather
// than on <code>. Carry it into the fence without leaking the UI label.
converter.addRule("code-language-label", {
  filter(node) {
    const next = node.nextElementSibling;
    return node.nodeName === "SPAN" && next?.nodeName === "PRE" && Boolean(next.querySelector("code"))
      && /^(?:javascript|typescript|js|ts|jsx|tsx|python|py|bash|sh|shell|zsh|json|html|css|go|rust|java|c|cpp|csharp|sql|yaml|yml|text|plaintext|markdown|ruby|php|swift|kotlin|xml|toml|ini|diff|powershell)$/i.test(node.textContent?.trim() ?? "");
  },
  replacement(_content, node) {
    const code = node.nextElementSibling?.querySelector("code");
    if (code && !/(?:language|lang)-/.test(code.className)) code.className = `${code.className} language-${node.textContent?.trim().toLowerCase()}`.trim();
    return "";
  },
});
converter.addRule("fenced-pre", {
  filter: "pre",
  replacement(_content, node) {
    const code = node.querySelector("code");
    const text = (code?.textContent ?? node.textContent ?? "").replace(/\n$/, "");
    const language = code?.className.match(/(?:language|lang)-([\w+-]+)/)?.[1] ?? "";
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
  },
});

export function toMarkdown(html: string): string { return converter.turndown(html).trim(); }

// Hold the last block while the renderer can still change it. Incomplete code
// blocks and inline markup never become an append-only SSE prefix prematurely.
function committedBoundary(text: string): number {
  let fence: string | undefined;
  let boundary = 0;
  let offset = 0;
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1]![0] === fence[0] && match[1]!.length >= fence.length) fence = undefined;
    }
    offset += line.length + 1;
    if (!fence && line === "" && offset < text.length) boundary = offset;
  }
  return boundary;
}

export class MarkdownStream {
  private emitted = "";
  update(markdown: string, complete = false): string {
    if (!markdown.startsWith(this.emitted)) {
      if (!complete) return ""; // Transient remount; only an authoritative final conflict fails.
      throw new WebError("The page rewrote text already streamed; start a fresh request", 502, "stream_rewritten");
    }
    const end = complete ? markdown.length : committedBoundary(markdown);
    if (end <= this.emitted.length) return "";
    const delta = markdown.slice(this.emitted.length, end);
    this.emitted = markdown.slice(0, end);
    return delta;
  }
  get text(): string { return this.emitted; }
}
