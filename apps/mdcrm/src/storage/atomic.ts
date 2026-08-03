import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface AtomicWriteOptions {
  overwrite?: boolean;
  validate?: (content: string) => void | Promise<void>;
}

/** Write, fsync, validate, then rename a same-directory temporary file. */
export async function atomicWriteFile(
  destination: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(destination)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await options.validate?.(content);
    if (!options.overwrite) {
      // Exclusive destination creation: hard-linking cannot replace an existing
      // path, then the temporary name is removed. Same filesystem is guaranteed.
      const { link } = await import("node:fs/promises");
      await link(temporary, destination);
      await unlink(temporary);
    } else {
      await rename(temporary, destination);
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
