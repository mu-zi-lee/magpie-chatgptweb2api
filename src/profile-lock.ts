import lockfile from "proper-lockfile";
import { lstat } from "node:fs/promises";
import { WebError } from "./errors.js";

export interface ProfileLease {
  signal: AbortSignal;
  abort(): void;
  release(): Promise<void>;
}

export async function lockProfile(directory: string): Promise<ProfileLease> {
  const lockPath = `${directory}.operation.lock`;
  try {
    const stat = await lstat(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WebError("Profile lock is invalid; check the dedicated profile directory", 409, "profile_lock_invalid");
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const controller = new AbortController();
  let unlock: () => Promise<void>;
  try {
    unlock = await lockfile.lock(directory, {
      realpath: true, lockfilePath: lockPath, retries: 0,
      stale: 30_000, update: 5_000,
      onCompromised: () => controller.abort(new WebError("The profile operation lock was lost; request stopped without resending", 409, "profile_lock_lost")),
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOCKED") throw new WebError("This account has an operation in another process; wait before retrying", 429, "account_busy");
    throw new WebError("Unable to acquire the profile operation lock", 503, "profile_lock_unavailable");
  }
  let released = false;
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    async release() { if (!released) { released = true; await unlock().catch(() => {}); } },
  };
}
