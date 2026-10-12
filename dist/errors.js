export class WebError extends Error {
    status;
    code;
    constructor(message, status = 502, code = "web_error") {
        super(message);
        this.status = status;
        this.code = code;
        this.name = "WebError";
    }
}
export function abortError() {
    return new WebError("The request was cancelled", 499, "cancelled");
}
export function checkAbort(signal) {
    if (signal?.aborted)
        throw signal.reason instanceof WebError ? signal.reason : abortError();
}
export function delay(ms, signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const timer = setTimeout(finish, ms);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(abortError()); };
        signal?.addEventListener("abort", abort, { once: true });
    });
}
export function publicError(error) {
    if (error instanceof WebError)
        return error;
    // Playwright errors can include evaluated arguments, page content and local paths.
    return new WebError("The browser operation failed; check the browser window and retry", 502, "browser_operation_failed");
}
export function errorBody(error) {
    const e = publicError(error);
    return { error: { message: e.message, type: e.status === 400 ? "invalid_request_error" : "web_error", code: e.code } };
}
