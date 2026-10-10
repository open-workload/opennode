import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NodeIdentityKeystore, StoredNodeIdentity } from "@workspace/opennode-domain";

const DEFAULT_FILENAME = "node-identity.json";

export function defaultNodeIdentityPath(baseDir: string = process.cwd()): string {
  return (
    process.env.OPENNODE_KEYSTORE_PATH ??
    join(baseDir, ".local", "opennode", DEFAULT_FILENAME)
  );
}

export class NodeStoreIdentityKeystore implements NodeIdentityKeystore {
  private readonly path: string;

  constructor(path: string = defaultNodeIdentityPath()) {
    this.path = path;
  }

  load(): StoredNodeIdentity | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<StoredNodeIdentity>;
    if (typeof parsed?.secretKey !== "string" || typeof parsed?.nodeId !== "string") {
      return undefined;
    }
    return { secretKey: parsed.secretKey, nodeId: parsed.nodeId };
  }

  save(identity: StoredNodeIdentity): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(
      this.path,
      JSON.stringify({ secretKey: identity.secretKey, nodeId: identity.nodeId }),
      { mode: 0o600 },
    );
  }
}
