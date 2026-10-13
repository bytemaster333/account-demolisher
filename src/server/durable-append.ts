import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";

// fsync a directory, so a file created or renamed in it survives a power loss
export async function syncDir(dir: string): Promise<void> {
  const dirHandle = await fs.open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

// append one line and fsync it. the file is checked for a torn tail first: a
// crash, or an append that failed part way (ENOSPC, say) in this same process,
// leaves a partial line without its newline, and gluing the next line onto it
// would lose that line on the next load as well.
export async function appendLineDurably(file: string, line: string): Promise<void> {
  const fh = await fs.open(file, "a+");
  let wasEmpty: boolean;
  try {
    const { size } = await fh.stat();
    wasEmpty = size === 0;
    let lead = "";
    if (size > 0) {
      const last = Buffer.alloc(1);
      await fh.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = "\n";
    }
    await fh.writeFile(`${lead}${line}\n`, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  // an empty file may be one this open just created, and its directory entry is
  // not on disk until the directory itself is synced. syncing on every empty
  // start also covers a file created by an earlier append that died before this
  // step.
  if (wasEmpty) await syncDir(path.dirname(file));
}
