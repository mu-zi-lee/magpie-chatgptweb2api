import { type Options } from "./options.js";
import { type BrowserEvent, type Completion } from "./protocol.js";
export declare class BrowserBridge {
    private options;
    private site?;
    private child?;
    private starting?;
    private closed;
    private nextId;
    private pending;
    private exitHandler;
    constructor(options: Options, site?: string | undefined);
    private start;
    private send;
    private finish;
    private cancel;
    private failAll;
    private receive;
    private attach;
    private rawCall;
    call<T>(method: "loginBegin" | "cookieBegin" | "loginWait" | "guestBegin" | "guestWait" | "status", params: unknown, signal?: AbortSignal): Promise<T>;
    open(profileId: string, completion: Completion, signal?: AbortSignal): Promise<AsyncIterableIterator<BrowserEvent>>;
    close(): Promise<void>;
}
