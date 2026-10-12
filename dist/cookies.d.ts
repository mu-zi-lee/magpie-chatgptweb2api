import type { BrowserContext } from "playwright";
type ImportedCookie = Parameters<BrowserContext["addCookies"]>[0][number];
export declare function cookieFilePath(input: unknown): string;
export declare function normalizeCookies(input: unknown, site?: string, now?: number): ImportedCookie[];
export declare function parseCookieHeader(input: string, site?: string): ImportedCookie[];
export declare function readCookieFile(input: unknown, site?: string): Promise<ImportedCookie[]>;
export {};
