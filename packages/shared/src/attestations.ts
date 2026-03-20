export type ContentAttestationType = "upload" | "approval" | "transformation" | "publish" | "update";
export type ContentAttestationAuthMethod = "passkey" | "session" | "api-key";
export type ContentAttestationAuthLevel = "phishing-resistant" | "standard";

export type ContentAttestationActor = {
  id: string;
  displayName?: string;
  organization?: string;
  role?: string;
};

export type ContentAttestationAuth = {
  method: ContentAttestationAuthMethod;
  level: ContentAttestationAuthLevel;
};

export type ContentAttestationInput = {
  type: ContentAttestationType;
  actor: ContentAttestationActor;
  auth: ContentAttestationAuth;
  timestamp?: string;
  notes?: string;
  relatedContentHashes?: string[];
  metadata?: Record<string, string | number | boolean | null>;
};

export type ContentAttestation = {
  schemaVersion: number;
  id: string;
  type: ContentAttestationType;
  actor: ContentAttestationActor;
  auth: ContentAttestationAuth;
  timestamp: string;
  notes?: string;
  subjectContentHash: string;
  relatedContentHashes?: string[];
  metadata?: Record<string, string | number | boolean | null>;
  issuerOperatorId: string;
  issuerKeyId: string;
  issuerPublicKeySha256: string;
  signatureAlgorithm: "ed25519";
  attestationHash: string;
  signature: string;
};

export type AttestationBundle = {
  schemaVersion: number;
  bundleType: "auth-layer-attestation-bundle";
  attestations: ContentAttestation[];
};

export type AttestationSummary = {
  hasAttestations: boolean;
  attestationCount: number;
  attestationTypes: ContentAttestationType[];
  actors: string[];
  warnings: string[];
};

const normalizeText = (value: string): string => value.normalize("NFC");

const sortObjectKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nestedValue]) => nestedValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortObjectKeys(nestedValue)])
    );
  }

  if (typeof value === "string") {
    return normalizeText(value);
  }

  return value;
};

const stableStringify = (value: unknown): string => JSON.stringify(sortObjectKeys(value));

const hashString = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

export const stableAttestationPayload = (attestation: Omit<ContentAttestation, "attestationHash" | "signature">) => ({
  schemaVersion: attestation.schemaVersion,
  id: attestation.id,
  type: attestation.type,
  actor: attestation.actor,
  auth: attestation.auth,
  timestamp: attestation.timestamp,
  notes: attestation.notes,
  subjectContentHash: attestation.subjectContentHash,
  relatedContentHashes: attestation.relatedContentHashes,
  metadata: attestation.metadata,
  issuerOperatorId: attestation.issuerOperatorId,
  issuerKeyId: attestation.issuerKeyId,
  issuerPublicKeySha256: attestation.issuerPublicKeySha256,
  signatureAlgorithm: attestation.signatureAlgorithm
});

export const computeContentAttestationHash = async (
  attestation: Omit<ContentAttestation, "attestationHash" | "signature">
): Promise<string> => hashString(stableStringify(stableAttestationPayload(attestation)));

export const hashAttestationBundle = async (bundle: AttestationBundle): Promise<string> => hashString(stableStringify(bundle));

export const summarizeAttestationBundle = (bundle?: AttestationBundle): AttestationSummary => {
  if (!bundle?.attestations.length) {
    return {
      hasAttestations: false,
      attestationCount: 0,
      attestationTypes: [],
      actors: [],
      warnings: bundle ? ["Attestation bundle is present but contains no attestations."] : []
    };
  }

  const actors = [...new Set(bundle.attestations.map((attestation) => attestation.actor.displayName ?? attestation.actor.id))];
  const warnings: string[] = [];
  const seenIds = new Set<string>();
  for (const attestation of bundle.attestations) {
    if (seenIds.has(attestation.id)) {
      warnings.push(`Duplicate attestation ID detected: ${attestation.id}`);
    }
    seenIds.add(attestation.id);
  }

  return {
    hasAttestations: true,
    attestationCount: bundle.attestations.length,
    attestationTypes: [...new Set(bundle.attestations.map((attestation) => attestation.type))],
    actors,
    warnings
  };
};

