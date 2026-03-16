export type StoredObject = {
  body: Buffer;
  contentType?: string;
};

export interface ObjectStore {
  putObject(key: string, body: string | Buffer, contentType?: string): Promise<string>;
  putJson<T>(key: string, value: T): Promise<string>;
  getObject(key: string): Promise<StoredObject | undefined>;
  getText(key: string): Promise<string | undefined>;
  exists(key: string): Promise<boolean>;
}
