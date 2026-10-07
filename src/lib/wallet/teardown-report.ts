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
