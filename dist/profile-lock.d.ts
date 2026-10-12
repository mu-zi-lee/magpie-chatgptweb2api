export interface ProfileLease {
    signal: AbortSignal;
    abort(): void;
    release(): Promise<void>;
}
export declare function lockProfile(directory: string): Promise<ProfileLease>;
