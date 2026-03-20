export type LineageDerivationType =
  | "verbatim"
  | "trimmed"
  | "paraphrased"
  | "headline"
  | "summary"
  | "excerpt"
  | "translation"
  | "revision";

export type LineageContentType =
  | "quote"
  | "transcript-segment"
  | "excerpt"
  | "article-snippet"
  | "headline"
  | "summary"
  | "claim";

export type LineageSourceRef = {
  captureId?: string;
  sourceLabel?: string;
  requestedUrl?: string;
  artifactPath?: string;
  objectId?: string;
  externalRef?: string;
};

export type LineageLocationRef = {
  startOffset?: number;
  endOffset?: number;
  startTimestampMs?: number;
  endTimestampMs?: number;
  pageNumber?: number;
  sectionLabel?: string;
};

export type LineageDeclaredBy = {
  actorId?: string;
  displayName?: string;
  role?: string;
};

export type LineageContentObject = {
  id: string;
  type: LineageContentType;
  text: string;
  language?: string;
  sourceRef?: LineageSourceRef;
  contextBefore?: string;
  contextAfter?: string;
  speaker?: string;
  capturedAt?: string;
  locationInSource?: LineageLocationRef;
  metadata?: Record<string, unknown>;
};

export type LineageEdge = {
  from: string;
  to: string;
  derivationType: LineageDerivationType;
  declaredBy?: LineageDeclaredBy;
  createdAt?: string;
  notes?: string;
  transformMetadata?: Record<string, unknown>;
};

export type LineageBundle = {
  schemaVersion: number;
  bundleType: "auth-layer-lineage-bundle";
  subject?: string;
  subjectIdentifiers?: string[];
  contentObjects: LineageContentObject[];
  edges: LineageEdge[];
  rootObjectIds?: string[];
};

export type LineageWarningCode =
  | "empty-bundle"
  | "duplicate-node-id"
  | "missing-edge-node"
  | "invalid-derivation-type"
  | "cycle-detected"
  | "multiple-roots"
  | "no-root"
  | "disconnected-graph"
  | "multiple-parents"
  | "verbatim-text-mismatch"
  | "trimmed-text-mismatch"
  | "semantic-equivalence-not-proven";

export type LineageWarning = {
  code: LineageWarningCode;
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  edgeFrom?: string;
  edgeTo?: string;
};

export type LineageValidationResult = {
  ok: boolean;
  roots: string[];
  errors: LineageWarning[];
  warnings: LineageWarning[];
  nodeCount: number;
  edgeCount: number;
};

export type LineageSummary = {
  hasLineage: boolean;
  lineageNodeCount: number;
  lineageEdgeCount: number;
  lineageRoots: string[];
  lineageWarnings: LineageWarning[];
};

const LINEAGE_DERIVATION_TYPES = new Set<LineageDerivationType>([
  "verbatim",
  "trimmed",
  "paraphrased",
  "headline",
  "summary",
  "excerpt",
  "translation"
]);

const sortKeysExact = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeysExact);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nestedValue]) => nestedValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortKeysExact(nestedValue)])
    );
  }

  return value;
};

export const stableLineageStringify = (value: unknown): string => JSON.stringify(sortKeysExact(value));

const hashString = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

export const hashLineageContentObject = async (value: LineageContentObject): Promise<string> =>
  hashString(stableLineageStringify(value));

export const hashLineageEdge = async (value: LineageEdge): Promise<string> =>
  hashString(stableLineageStringify(value));

export const hashLineageBundle = async (value: LineageBundle): Promise<string> =>
  hashString(stableLineageStringify(value));

export const isExactLineageTextMatch = (parentText: string, childText: string): boolean => parentText === childText;

export const isTrimmedLineageTextMatch = (parentText: string, childText: string): boolean =>
  childText.length > 0 && parentText.includes(childText);

export const createLineageContentObject = (input: LineageContentObject): LineageContentObject => ({ ...input });

export const createLineageEdge = (input: LineageEdge): LineageEdge => ({ ...input });

export const createLineageBundle = (input: Omit<LineageBundle, "schemaVersion" | "bundleType"> & { schemaVersion?: number }): LineageBundle => ({
  schemaVersion: input.schemaVersion ?? 1,
  bundleType: "auth-layer-lineage-bundle",
  subject: input.subject,
  subjectIdentifiers: input.subjectIdentifiers,
  contentObjects: input.contentObjects.map((object) => ({ ...object })),
  edges: input.edges.map((edge) => ({ ...edge })),
  rootObjectIds: input.rootObjectIds
});

export const validateLineageBundle = (bundle: LineageBundle): LineageValidationResult => {
  const errors: LineageWarning[] = [];
  const warnings: LineageWarning[] = [];
  const nodeMap = new Map<string, LineageContentObject>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  if (bundle.contentObjects.length === 0) {
    warnings.push({
      code: "empty-bundle",
      severity: "warning",
      message: "Lineage bundle contains no content objects."
    });
  }

  for (const object of bundle.contentObjects) {
    if (nodeMap.has(object.id)) {
      errors.push({
        code: "duplicate-node-id",
        severity: "error",
        nodeId: object.id,
        message: `Lineage bundle contains duplicate content object id \"${object.id}\".`
      });
      continue;
    }

    nodeMap.set(object.id, object);
    incoming.set(object.id, 0);
    outgoing.set(object.id, []);
  }

  for (const edge of bundle.edges) {
    if (!LINEAGE_DERIVATION_TYPES.has(edge.derivationType)) {
      errors.push({
        code: "invalid-derivation-type",
        severity: "error",
        edgeFrom: edge.from,
        edgeTo: edge.to,
        message: `Lineage edge ${edge.from} -> ${edge.to} declares an invalid derivation type.`
      });
    }

    const fromNode = nodeMap.get(edge.from);
    const toNode = nodeMap.get(edge.to);
    if (!fromNode || !toNode) {
      errors.push({
        code: "missing-edge-node",
        severity: "error",
        edgeFrom: edge.from,
        edgeTo: edge.to,
        message: `Lineage edge ${edge.from} -> ${edge.to} references a missing content object.`
      });
      continue;
    }

    outgoing.get(edge.from)?.push(edge.to);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);

    if ((incoming.get(edge.to) ?? 0) > 1) {
      warnings.push({
        code: "multiple-parents",
        severity: "warning",
        nodeId: edge.to,
        edgeFrom: edge.from,
        edgeTo: edge.to,
        message: `Content object \"${edge.to}\" has multiple parent derivations.`
      });
    }

    if (edge.derivationType === "verbatim" && !isExactLineageTextMatch(fromNode.text, toNode.text)) {
      warnings.push({
        code: "verbatim-text-mismatch",
        severity: "warning",
        edgeFrom: edge.from,
        edgeTo: edge.to,
        message: `Edge ${edge.from} -> ${edge.to} is marked verbatim, but the texts do not match exactly.`
      });
    }

    if ((edge.derivationType === "trimmed" || edge.derivationType === "excerpt") && !isTrimmedLineageTextMatch(fromNode.text, toNode.text)) {
      warnings.push({
        code: "trimmed-text-mismatch",
        severity: "warning",
        edgeFrom: edge.from,
        edgeTo: edge.to,
        message: `Edge ${edge.from} -> ${edge.to} is marked ${edge.derivationType}, but the child text is not an exact excerpt of the parent text.`
      });
    }

    if (["paraphrased", "headline", "summary", "translation"].includes(edge.derivationType)) {
      warnings.push({
        code: "semantic-equivalence-not-proven",
        severity: "warning",
        edgeFrom: edge.from,
        edgeTo: edge.to,
        message: `Edge ${edge.from} -> ${edge.to} is marked ${edge.derivationType}. Provenance is declared, but exact semantic equivalence is not proven by deterministic checks.`
      });
    }
  }

  const roots = Array.from(nodeMap.keys()).filter((id) => (incoming.get(id) ?? 0) === 0);
  if (nodeMap.size > 0 && roots.length === 0) {
    warnings.push({
      code: "no-root",
      severity: "warning",
      message: "Lineage bundle has no root nodes."
    });
  }
  if (roots.length > 1) {
    warnings.push({
      code: "multiple-roots",
      severity: "warning",
      message: `Lineage bundle has multiple roots: ${roots.join(", ")}.`
    });
  }

  const indegree = new Map(incoming);
  const queue = Array.from(nodeMap.keys()).filter((id) => (indegree.get(id) ?? 0) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    visited += 1;
    for (const next of outgoing.get(current) ?? []) {
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
      }
    }
  }

  if (visited !== nodeMap.size && nodeMap.size > 0) {
    errors.push({
      code: "cycle-detected",
      severity: "error",
      message: "Lineage bundle contains a cycle. Quote lineage must remain a DAG."
    });
  }

  const undirected = new Map<string, string[]>();
  for (const id of nodeMap.keys()) {
    undirected.set(id, []);
  }
  for (const edge of bundle.edges) {
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) {
      continue;
    }
    undirected.get(edge.from)?.push(edge.to);
    undirected.get(edge.to)?.push(edge.from);
  }

  const componentVisited = new Set<string>();
  let componentCount = 0;
  for (const id of nodeMap.keys()) {
    if (componentVisited.has(id)) {
      continue;
    }
    componentCount += 1;
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || componentVisited.has(current)) {
        continue;
      }
      componentVisited.add(current);
      for (const next of undirected.get(current) ?? []) {
        stack.push(next);
      }
    }
  }

  if (componentCount > 1) {
    warnings.push({
      code: "disconnected-graph",
      severity: "warning",
      message: "Lineage bundle contains disconnected components."
    });
  }

  return {
    ok: errors.length === 0,
    roots,
    errors,
    warnings,
    nodeCount: bundle.contentObjects.length,
    edgeCount: bundle.edges.length
  };
};

export const summarizeLineageBundle = (bundle?: LineageBundle): LineageSummary => {
  if (!bundle) {
    return {
      hasLineage: false,
      lineageNodeCount: 0,
      lineageEdgeCount: 0,
      lineageRoots: [],
      lineageWarnings: []
    };
  }

  const validation = validateLineageBundle(bundle);
  return {
    hasLineage: true,
    lineageNodeCount: validation.nodeCount,
    lineageEdgeCount: validation.edgeCount,
    lineageRoots: validation.roots,
    lineageWarnings: [...validation.errors, ...validation.warnings]
  };
};



