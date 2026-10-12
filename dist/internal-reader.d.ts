import type { Page } from "playwright";
export interface InternalReply {
    text: string;
    complete: boolean;
}
export declare function projectReply(payload: unknown, userId: string, maxChars: number): InternalReply | undefined;
export declare function readInternalReply(page: Page, userId: string, maxChars: number, expectedIdentity?: string): Promise<InternalReply | undefined>;
