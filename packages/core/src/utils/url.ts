const TRACKING_PARAM_PATTERNS = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^mc_/i, /^vero_/i, /^mkt_tok$/i];

const hasProtocol = (input: string): boolean => /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(input);

export const stripTrackingParams = (url: URL): URL => {
  const next = new URL(url.toString());

  for (const key of [...next.searchParams.keys()]) {
    if (TRACKING_PARAM_PATTERNS.some((pattern) => pattern.test(key))) {
      next.searchParams.delete(key);
    }
  }

  next.searchParams.sort();
  return next;
};

export const normalizeRequestedUrl = (input: string): string => {
  const trimmed = input.trim();
  const url = new URL(hasProtocol(trimmed) ? trimmed : `https://${trimmed}`);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }

  return url.toString();
};

export const normalizeContentUrl = (candidate: string | undefined, baseUrl: string): string | undefined => {
  if (!candidate) {
    return undefined;
  }

  try {
    const url = new URL(candidate, baseUrl);
    url.hash = "";
    return stripTrackingParams(url).toString();
  } catch {
    return undefined;
  }
};
