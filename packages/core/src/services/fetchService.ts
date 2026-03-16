import type { RawSnapshot } from "@auth-layer/shared";

const CAPTURED_HEADER_ALLOWLIST = [
  "content-type",
  "cache-control",
  "etag",
  "last-modified",
  "date",
  "content-language",
  "content-length"
];

const parseCharset = (contentType: string | null): string | undefined => {
  if (!contentType) {
    return undefined;
  }

  const match = contentType.match(/charset=([^;]+)/i);
  return match?.[1]?.trim().toLowerCase();
};

const decodeBody = (body: Buffer, charset?: string): string => {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
};

export type FetchedPage = {
  snapshot: Omit<RawSnapshot, "rawHtmlStorageKey">;
  rawHtml: string;
};

export class FetchService {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async fetch(url: string): Promise<FetchedPage> {
    const response = await this.fetchImpl(url, {
      redirect: "follow",
      headers: {
        "user-agent": "AuthLayerMVP/0.1 (+https://auth-layer.local)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    const contentTypeHeader = response.headers.get("content-type");
    const charset = parseCharset(contentTypeHeader);
    const body = Buffer.from(await response.arrayBuffer());
    const rawHtml = decodeBody(body, charset);
    const capturedHeaders = Object.fromEntries(
      CAPTURED_HEADER_ALLOWLIST.flatMap((headerName) => {
        const value = response.headers.get(headerName);
        return value ? [[headerName, value]] : [];
      })
    );

    return {
      rawHtml,
      snapshot: {
        schemaVersion: 1,
        requestedUrl: url,
        finalUrl: response.url || url,
        fetchedAt: new Date().toISOString(),
        httpStatus: response.status,
        headers: capturedHeaders,
        contentType: contentTypeHeader?.split(";")[0]?.trim(),
        charset
      }
    };
  }
}
