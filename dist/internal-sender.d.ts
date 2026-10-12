import type { Page } from "playwright";
export declare function sendInternal(page: Page, prompt: string, model: string, timeoutMs: number, maxChars: number, signal?: AbortSignal, expectedIdentity?: string): Promise<string | undefined>;
