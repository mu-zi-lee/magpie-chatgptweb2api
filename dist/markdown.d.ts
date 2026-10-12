export declare function toMarkdown(html: string): string;
export declare class MarkdownStream {
    private emitted;
    update(markdown: string, complete?: boolean): string;
    get text(): string;
}
