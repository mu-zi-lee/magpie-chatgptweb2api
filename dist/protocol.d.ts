import { type Options } from "./options.js";
export interface Completion {
    model: string;
    prompt: string;
    stream: boolean;
}
export type BrowserEvent = {
    event: "ready";
    modelLabel: string;
} | {
    event: "delta";
    text: string;
} | {
    event: "done";
};
export declare function prepare(body: unknown, options: Options): Completion;
export declare function completionResponse(source: AsyncIterableIterator<BrowserEvent>, completion: Completion, signal?: AbortSignal): Promise<Response>;
