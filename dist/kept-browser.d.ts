import { type Browser, type BrowserContext } from "playwright";
import { type Options } from "./options.js";
export declare function connectKeptBrowser(directory: string, options: Options, site: string): Promise<{
    browser: Browser;
    context: BrowserContext;
}>;
