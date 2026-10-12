import { type Options } from "./options.js";
import { type BrowserEvent, type Completion } from "./protocol.js";
interface AuthStatus {
    authenticated: boolean;
    anonymous?: boolean;
    ready?: boolean;
    identity?: string;
    accountId?: string;
}
export declare class BrowserRuntime {
    readonly options: Options;
    private entries;
    private busy;
    private leases;
    private closed;
    private openingCount;
    private origin;
    constructor(options: Options, site?: string);
    private directory;
    private marker;
    private acquire;
    private release;
    private context;
    private auth;
    private requireAuth;
    private checkVerification;
    private waitForComposer;
    private begin;
    beginLogin(signal?: AbortSignal, profileId?: string): Promise<{
        profileId: string;
    }>;
    beginGuest(signal?: AbortSignal): Promise<{
        profileId: string;
    }>;
    beginCookieLogin(file: unknown, signal?: AbortSignal): Promise<{
        profileId: string;
    }>;
    waitLogin(id: string, signal?: AbortSignal): Promise<AuthStatus>;
    waitGuest(id: string, signal?: AbortSignal): Promise<AuthStatus>;
    status(id: string, signal?: AbortSignal): Promise<AuthStatus & {
        modelLabel?: string;
        browserMode?: string;
        windowKeptOpen?: boolean;
    }>;
    private selectModel;
    private snapshot;
    private readSnapshot;
    private checkAlerts;
    complete(id: string, completion: Completion, signal?: AbortSignal): AsyncGenerator<BrowserEvent>;
    close(): Promise<void>;
}
export {};
