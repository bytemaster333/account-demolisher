import { errorMessage } from "@/lib/errors";

// hands a wallet teardown failure to the caller's reporter. the teardown runs
// after the app has already let go of the wallet (or after a signature that
// must be kept), so a reporter that throws itself must not change that outcome:
// its error and the original failure both go to the console instead.
export function reportTeardownError(report: (error: unknown) => void, error: unknown): void {
  try {
    report(error);
  } catch (reportError) {
    console.error("could not report a wallet teardown failure", reportError, error);
  }
}

// more than one part of a teardown failed. callers show only the message, so it
// names every reason, not just that something went wrong.
export function teardownFailures(failures: readonly unknown[]): AggregateError {
  const reasons = failures.map((f) => errorMessage(f, "unknown error")).join("; ");
  return new AggregateError(failures, `The wallet could not be disconnected: ${reasons}`);
}
