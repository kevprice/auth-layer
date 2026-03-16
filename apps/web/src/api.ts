import type { CaptureComparison, CaptureDetail, CaptureRecord, CreateCaptureRequest, CreatePdfCaptureRequest, CreateWatchlistRequest, OperatorPublicKey, UpdateWatchlistRequest, Watchlist, WatchlistRun } from "@auth-layer/shared";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

const readJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const error = (await response.json().catch(() => ({ error: "Request failed" }))) as { error?: string };
    throw new Error(error.error ?? "Request failed");
  }

  return (await response.json()) as T;
};

export const createCapture = async (payload: CreateCaptureRequest): Promise<CaptureRecord> => {
  const response = await fetch(`${API_BASE}/api/captures`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await readJson<{ capture: CaptureRecord }>(response);
  return data.capture;
};

export const getCapture = async (captureId: string): Promise<CaptureDetail> => {
  const response = await fetch(`${API_BASE}/api/captures/${captureId}`);
  return readJson<CaptureDetail>(response);
};

export const getCaptureHistory = async (url: string): Promise<{ normalizedRequestedUrl: string; captures: CaptureRecord[] }> => {
  const response = await fetch(`${API_BASE}/api/urls/${encodeURIComponent(url)}/captures`);
  return readJson<{ normalizedRequestedUrl: string; captures: CaptureRecord[] }>(response);
};

export const getCaptureComparison = async (input: {
  url: string;
  fromCaptureId?: string;
  toCaptureId?: string;
  fromCapturedAt?: string;
  toCapturedAt?: string;
}): Promise<{ normalizedRequestedUrl: string; comparison: CaptureComparison }> => {
  const params = new URLSearchParams();

  if (input.fromCaptureId && input.toCaptureId) {
    params.set("fromCaptureId", input.fromCaptureId);
    params.set("toCaptureId", input.toCaptureId);
  }

  if (input.fromCapturedAt && input.toCapturedAt) {
    params.set("fromCapturedAt", input.fromCapturedAt);
    params.set("toCapturedAt", input.toCapturedAt);
  }

  const response = await fetch(`${API_BASE}/api/urls/${encodeURIComponent(input.url)}/compare?${params.toString()}`);
  return readJson<{ normalizedRequestedUrl: string; comparison: CaptureComparison }>(response);
};

export const artifactUrl = (captureId: string, kind: string): string => `${API_BASE}/api/captures/${captureId}/artifacts/${kind}`;

export const getOperatorPublicKey = async (): Promise<OperatorPublicKey> => {
  const response = await fetch(`${API_BASE}/api/transparency/operator-key`);
  const data = await readJson<{ operatorPublicKey: OperatorPublicKey }>(response);
  return data.operatorPublicKey;
};



export const createPdfCapture = async (input: {
  file: File;
  approval?: CreatePdfCaptureRequest["approval"];
}): Promise<CaptureRecord> => {
  const formData = new FormData();
  formData.set("file", input.file);
  formData.set("fileName", input.file.name);
  formData.set("mediaType", input.file.type || "application/pdf");

  if (input.approval?.actorAccountId) {
    formData.set("actorAccountId", input.approval.actorAccountId);
  }

  if (input.approval?.approvalType) {
    formData.set("approvalType", input.approval.approvalType);
  }

  if (input.approval?.approvalScope) {
    formData.set("approvalScope", input.approval.approvalScope);
  }

  if (input.approval?.approvalMethod) {
    formData.set("approvalMethod", input.approval.approvalMethod);
  }

  const response = await fetch(`${API_BASE}/api/pdfs`, {
    method: "POST",
    body: formData
  });

  const data = await readJson<{ capture: CaptureRecord }>(response);
  return data.capture;
};

export const listWatchlists = async (): Promise<Watchlist[]> => {
  const response = await fetch(`${API_BASE}/api/watchlists`);
  const data = await readJson<{ watchlists: Watchlist[] }>(response);
  return data.watchlists;
};

export const createWatchlist = async (payload: CreateWatchlistRequest): Promise<Watchlist> => {
  const response = await fetch(`${API_BASE}/api/watchlists`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const data = await readJson<{ watchlist: Watchlist }>(response);
  return data.watchlist;
};

export const updateWatchlist = async (watchlistId: string, payload: UpdateWatchlistRequest): Promise<Watchlist> => {
  const response = await fetch(`${API_BASE}/api/watchlists/${watchlistId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const data = await readJson<{ watchlist: Watchlist }>(response);
  return data.watchlist;
};

export const getWatchlistRuns = async (watchlistId: string): Promise<{ watchlist: Watchlist; runs: WatchlistRun[] }> => {
  const response = await fetch(`${API_BASE}/api/watchlists/${watchlistId}/runs`);
  return readJson<{ watchlist: Watchlist; runs: WatchlistRun[] }>(response);
};

export const testWatchlistWebhook = async (watchlistId: string): Promise<{ ok: boolean; status?: number; error?: string }> => {
  const response = await fetch(`${API_BASE}/api/watchlists/${watchlistId}/test-webhook`, { method: "POST" });
  return readJson<{ ok: boolean; status?: number; error?: string }>(response);
};

export const retryWatchlist = async (watchlistId: string): Promise<WatchlistRun> => {
  const response = await fetch(`${API_BASE}/api/watchlists/${watchlistId}/retry`, { method: "POST" });
  const data = await readJson<{ run: WatchlistRun }>(response);
  return data.run;
};
