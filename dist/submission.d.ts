export type SubmissionState = "not-attempted" | "attempted" | "confirmed" | "completed";
export declare class Submission {
    private current;
    get state(): SubmissionState;
    attempt(): void;
    confirm(): void;
    complete(): void;
    get canFallbackSend(): boolean;
}
