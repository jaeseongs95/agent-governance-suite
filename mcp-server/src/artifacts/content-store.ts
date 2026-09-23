import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import type { ArtifactRefV1 } from "../../../contracts/types.js";
import { WorkflowContractError } from "../../../contracts/types.js";
import { ContractValidator, verifyArtifactRefContent } from "../schema-validator.js";

export interface ContentStorePutResult {
  ref: ArtifactRefV1;
  disposition: "created" | "existing";
  /** A successful OS directory sync is only best effort, not a power-loss guarantee. */
  directorySync: "attempt-succeeded" | "unsupported" | "not-attempted";
  durability: "best-effort";
}

/**
 * Store raw bytes under a trusted, absolute storage root. Callers cannot choose a per-write path.
 * A02 assumes the root is owned by the application; A03 adds namespace ACL and safe path opening.
 * Temp names are isolated from published objects. A crash before link leaves only an orphan temp;
 * a crash after link may leave both names. FileHandle.sync and directory sync are OS best effort:
 * Windows may not support directory sync, and neither operation promises power-loss durability.
 * Hard links require temp and object directories on the same filesystem. No rename fallback is used.
 */
export class RawContentStore {
  private readonly root: string;
  private readonly validator = new ContractValidator();

  constructor(approvedRoot: string) {
    if (!path.isAbsolute(approvedRoot)) {
      throw new WorkflowContractError("INVALID_INPUT", "Content store root must be an approved absolute path.");
    }
    this.root = path.resolve(approvedRoot);
  }

  async put(value: unknown, bytes: Uint8Array): Promise<ContentStorePutResult> {
    const ref = this.validator.artifactRef(value);
    if (ref.hashDomain !== "raw-bytes") {
      throw new WorkflowContractError("INVALID_INPUT", "Raw content store requires a raw-bytes reference.");
    }
    verifyArtifactRefContent(this.validator, ref, bytes);

    const temporaryDirectory = path.join(this.root, ".tmp");
    const objectDirectory = path.join(this.root, "objects", ref.namespace, ref.digest.slice(7, 9));
    const objectPath = path.join(objectDirectory, ref.digest.slice(7));
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.requireDirectories(this.root);
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    await mkdir(objectDirectory, { recursive: true, mode: 0o700 });
    await this.requireDirectories(temporaryDirectory, objectDirectory);

    const temporaryPath = path.join(temporaryDirectory, `${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      const temporary = await open(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      try {
        await temporary.writeFile(bytes);
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      await this.verifyPublished(temporaryPath, ref);
      let disposition: ContentStorePutResult["disposition"] = "created";
      try {
        // link is atomic and fails if the target already exists; rename can replace on POSIX.
        await link(temporaryPath, objectPath);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        disposition = "existing";
      }
      await this.verifyPublished(objectPath, ref);
      const directorySync = disposition === "created"
        ? await syncDirectory(objectDirectory) : "not-attempted";
      return { ref, disposition, directorySync, durability: "best-effort" };
    } finally {
      if (temporaryCreated) {
        await unlink(temporaryPath).catch((error: unknown) => {
          if (!isCode(error, "ENOENT")) throw error;
        });
      }
    }
  }

  private async requireDirectories(...directories: string[]): Promise<void> {
    for (const directory of [this.root, ...directories]) {
      if (!(await lstat(directory)).isDirectory()) {
        throw new WorkflowContractError("INVALID_INPUT", "Content store path is not a real directory.");
      }
    }
  }

  private async verifyPublished(objectPath: string, ref: ArtifactRefV1): Promise<void> {
    if (!(await lstat(objectPath)).isFile()) {
      throw new WorkflowContractError("INTEGRITY_FAILED", "Published artifact is not a regular file.");
    }
    const file = await open(objectPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await file.stat()).isFile()) {
        throw new WorkflowContractError("INTEGRITY_FAILED", "Published artifact is not a regular file.");
      }
      verifyArtifactRefContent(this.validator, ref, await file.readFile());
    } finally {
      await file.close();
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function syncDirectory(directory: string): Promise<ContentStorePutResult["directorySync"]> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
      return "attempt-succeeded";
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (["EINVAL", "EISDIR", "EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EBADF"]
      .some((code) => isCode(error, code))) return "unsupported";
    throw error;
  }
}
