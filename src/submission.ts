import { WebError } from "./errors.js";

export type SubmissionState = "not-attempted" | "attempted" | "confirmed" | "completed";

// Shared by transport adapters: an uncertain attempt must never authorize another send.
export class Submission {
  private current: SubmissionState = "not-attempted";
  get state(): SubmissionState { return this.current; }
  attempt(): void {
    if (this.current !== "not-attempted") throw new WebError("A submission was already attempted; no resend permitted", 409, "duplicate_submission_prevented");
    this.current = "attempted";
  }
  confirm(): void {
    if (this.current !== "attempted") throw new WebError("Invalid submission confirmation", 502, "invalid_submission_state");
    this.current = "confirmed";
  }
  complete(): void {
    if (this.current !== "confirmed") throw new WebError("Cannot complete an unconfirmed submission", 502, "invalid_submission_state");
    this.current = "completed";
  }
  get canFallbackSend(): boolean { return this.current === "not-attempted"; }
}
