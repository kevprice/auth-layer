import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ObjectStore, StoredObject } from "./objectStore.js";

const metaPath = (path: string): string => `${path}.meta.json`;

const sanitizeKey = (key: string): string =>
  key
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");

export class FileSystemObjectStore implements ObjectStore {
  constructor(private readonly rootDirectory: string) {}

  private resolvePath(key: string): string {
    return resolve(this.rootDirectory, sanitizeKey(key));
  }

  async putObject(key: string, body: string | Buffer, contentType = "application/octet-stream"): Promise<string> {
    const targetPath = this.resolvePath(key);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, body);
    await writeFile(metaPath(targetPath), JSON.stringify({ contentType }, null, 2));
    return key;
  }

  async putJson<T>(key: string, value: T): Promise<string> {
    return this.putObject(key, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
  }

  async getObject(key: string): Promise<StoredObject | undefined> {
    const targetPath = this.resolvePath(key);

    try {
      const [body, metadata] = await Promise.all([
        readFile(targetPath),
        readFile(metaPath(targetPath), "utf8").catch(() => undefined)
      ]);
      const parsedMetadata = metadata ? (JSON.parse(metadata) as { contentType?: string }) : undefined;
      return { body, contentType: parsedMetadata?.contentType };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  async getText(key: string): Promise<string | undefined> {
    const object = await this.getObject(key);
    return object?.body.toString("utf8");
  }

  async exists(key: string): Promise<boolean> {
    return Boolean(await this.getObject(key));
  }
}
