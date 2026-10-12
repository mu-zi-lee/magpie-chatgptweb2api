export declare class WebError extends Error {
    status: number;
    code: string;
    constructor(message: string, status?: number, code?: string);
}
export declare function abortError(): WebError;
export declare function checkAbort(signal?: AbortSignal): void;
export declare function delay(ms: number, signal?: AbortSignal): Promise<void>;
export declare function publicError(error: unknown): WebError;
export declare function errorBody(error: unknown): {
    error: {
        message: string;
        type: string;
        code: string;
    };
};
