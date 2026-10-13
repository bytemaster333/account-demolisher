import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// the server writes its data files (metrics, the co-sign log) under
// METRICS_DB_DIR, or data/ in the working tree when it is unset. unit tests that
// run the real routes get a throwaway directory instead.
process.env.METRICS_DB_DIR ??= mkdtempSync(path.join(tmpdir(), "demolisher-unit-data-"));
