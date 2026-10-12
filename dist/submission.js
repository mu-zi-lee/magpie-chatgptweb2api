import { WebError } from "./errors.js";
// Shared by transport adapters: an uncertain attempt must never authorize another send.
export class Submission {
    current = "not-attempted";
    get state() { return this.current; }
    attempt() {
        if (this.current !== "not-attempted")
            throw new WebError("A submission was already attempted; no resend permitted", 409, "duplicate_submission_prevented");
        this.current = "attempted";
    }
    confirm() {
        if (this.current !== "attempted")
            throw new WebError("Invalid submission confirmation", 502, "invalid_submission_state");
        this.current = "confirmed";
    }
    complete() {
        if (this.current !== "confirmed")
            throw new WebError("Cannot complete an unconfirmed submission", 502, "invalid_submission_state");
        this.current = "completed";
    }
    get canFallbackSend() { return this.current === "not-attempted"; }
}
