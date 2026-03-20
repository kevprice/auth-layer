import { useMemo, useState, type ChangeEvent } from "react";

import { browserVerifierLimits, type BrowserVerificationReport, verifyProofPackageZip } from "./browserVerifier";

const formatBytes = (value: number): string => {
  if (value >= 1024 * 1024) {
    return `${Math.round((value / (1024 * 1024)) * 10) / 10} MB`;
  }

  return `${Math.round(value / 1024)} KB`;
};

const statusTitle = (status: BrowserVerificationReport["status"]): string =>
  ({
    verified: "Verified",
    "partially-verified": "Partially verified",
    failed: "Failed"
  })[status];

const buildSummaryText = (report: BrowserVerificationReport): string => {
  const passedChecks = report.checks.filter((check) => check.status === "pass").map((check) => check.label.toLowerCase());
  const incompleteChecks = report.checks.filter((check) => check.status === "incomplete").map((check) => check.label.toLowerCase());
  const failedCheck = report.checks.find((check) => check.status === "fail");

  if (report.status === "verified") {
    return `Verification result: Verified. ${report.summary} Trust basis: ${report.trustBasisSummary} Passed checks: ${passedChecks.join(", ")}.`;
  }

  if (report.status === "partially-verified") {
    return `Verification result: Partially verified. ${report.summary} Incomplete checks: ${incompleteChecks.join(", ") || "none"}. Trust basis: ${report.trustBasisSummary}`;
  }

  return `Verification result: Failed. ${report.summary} First failing check: ${failedCheck?.label ?? "unknown"}.`;
};

const previewLineageText = (value: string): string =>
  value.length > 140 ? `${value.slice(0, 137)}...` : value;

const downloadJson = (report: BrowserVerificationReport): void => {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `verification-report-${report.packageInfo.captureId ?? "proof-package"}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
};

export const VerifierView = ({ goHome }: { goHome: () => void }) => {
  const [packageZip, setPackageZip] = useState<File | undefined>();
  const [checkpointFile, setCheckpointFile] = useState<File | undefined>();
  const [operatorKeyFiles, setOperatorKeyFiles] = useState<File[]>([]);
  const [report, setReport] = useState<BrowserVerificationReport | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [isVerifying, setIsVerifying] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | undefined>();
  const [discoveryUrl, setDiscoveryUrl] = useState("");
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryPreview, setDiscoveryPreview] = useState<{
    manifestUrl: string;
    title?: string;
    publisher?: string;
    publishedAt?: string;
    updatedAt?: string;
    attestationCount?: number;
    lineageNodeCount?: number;
    captureExportUrl?: string;
  } | undefined>();

  const summaryText = useMemo(() => (report ? buildSummaryText(report) : undefined), [report]);

  const verify = async () => {
    if (!packageZip) {
      return;
    }

    setIsVerifying(true);
    setActionNotice(undefined);
    setError(undefined);

    try {
      const nextReport = await verifyProofPackageZip({
        packageZip,
        checkpointFile,
        operatorKeyFiles
      });
      setReport(nextReport);
    } catch (nextError) {
      setReport(undefined);
      setError(nextError instanceof Error ? nextError.message : "Unable to verify this proof package.");
    } finally {
      setIsVerifying(false);
    }
  };

  const handleKeySelection = (event: ChangeEvent<HTMLInputElement>) => {
    setOperatorKeyFiles(Array.from(event.target.files ?? []));
  };

  const copySummary = async () => {
    if (!summaryText) {
      return;
    }

    await navigator.clipboard.writeText(summaryText);
    setActionNotice("Verification summary copied.");
  };


  const discoverManifest = async () => {
    if (!discoveryUrl.trim()) {
      return;
    }

    setIsDiscovering(true);
    setActionNotice(undefined);
    setError(undefined);

    try {
      const sourceUrl = discoveryUrl.trim();
      let manifestUrl = sourceUrl;
      if (!/\/api\/discovery\//.test(sourceUrl)) {
        const html = await fetch(sourceUrl).then(async (response) => {
          if (!response.ok) {
            throw new Error(`Unable to fetch page for manifest discovery (${response.status})`);
          }
          return response.text();
        });
        const match = html.match(/<link[^>]+rel=["']authenticity-manifest["'][^>]+href=["']([^"']+)["']/i);
        if (!match?.[1]) {
          throw new Error("No authenticity manifest link was found on that page.");
        }
        manifestUrl = new URL(match[1], sourceUrl).toString();
      }

      const manifestResponse = await fetch(manifestUrl);
      if (!manifestResponse.ok) {
        throw new Error(`Unable to load discovery manifest (${manifestResponse.status})`);
      }
      const manifestPayload = await manifestResponse.json() as {
        manifest?: {
          title?: string;
          publisher?: string;
          publishedAt?: string;
          updatedAt?: string;
          captureExportUrl?: string;
        };
      };
      const manifest = manifestPayload.manifest;
      if (!manifest?.captureExportUrl) {
        throw new Error("The discovery manifest did not include a capture export URL.");
      }

      const exportUrl = new URL(manifest.captureExportUrl, manifestUrl).toString();
      const exportPayload = await fetch(exportUrl).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Unable to load capture export (${response.status})`);
        }
        return response.json();
      }) as {
        attestationSummary?: { attestationCount?: number };
        lineageSummary?: { lineageNodeCount?: number };
      };

      setDiscoveryPreview({
        manifestUrl,
        title: manifest.title,
        publisher: manifest.publisher,
        publishedAt: manifest.publishedAt,
        updatedAt: manifest.updatedAt,
        attestationCount: exportPayload.attestationSummary?.attestationCount,
        lineageNodeCount: exportPayload.lineageSummary?.lineageNodeCount,
        captureExportUrl: exportUrl
      });
      setActionNotice("Discovery manifest loaded. This preview is a convenience layer; offline verification still happens from an exported proof package.");
    } catch (nextError) {
      setDiscoveryPreview(undefined);
      setError(nextError instanceof Error ? nextError.message : "Unable to discover authenticity metadata from that URL.");
    } finally {
      setIsDiscovering(false);
    }
  };
  return (
    <div className="detail-layout">
      <div className="detail-header">
        <button className="ghost-button" onClick={goHome}>Home</button>
      </div>

      <section className="headline-card headline-card--url">
        <div>
          <p className="eyebrow">Browser verifier</p>
          <h1>Verify a proof package without trusting the server UI.</h1>
          <p className="hero-copy">
            Upload a proof package zip, then optionally provide a checkpoint file and operator public key files. Verification runs on the exported
            artifacts in your browser and reports whether the package is verified, partially verified, or failed.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel__header"><h2>Manifest discovery</h2></div>
        <div className="field-grid">
          <div className="field-grid__row field-grid__row--wide">
            <span>Article page or manifest URL</span>
            <input value={discoveryUrl} onChange={(event) => setDiscoveryUrl(event.target.value)} placeholder="https://example.com/story" />
          </div>
        </div>
        <p className="metric-line">
          Discovery is a convenience layer. It can fetch a published page, detect <code>rel="authenticity-manifest"</code>, and load the latest article metadata, but offline verification still depends on an exported proof package.
        </p>
        <div className="detail-header">
          <button onClick={discoverManifest} disabled={!discoveryUrl.trim() || isDiscovering}>{isDiscovering ? "Discovering..." : "Discover manifest"}</button>
        </div>
        {discoveryPreview ? (
          <div className="summary-grid verifier-check-grid">
            <div className="summary-card">
              <span>Article</span>
              <strong>{discoveryPreview.title ?? "Untitled article"}</strong>
              <p className="metric-line">Publisher: {discoveryPreview.publisher ?? "Not available"}</p>
            </div>
            <div className="summary-card">
              <span>Workflow claims</span>
              <strong>{discoveryPreview.attestationCount ?? 0} attestation(s)</strong>
              <p className="metric-line">Revision lineage nodes: {discoveryPreview.lineageNodeCount ?? 0}</p>
            </div>
            <div className="summary-card">
              <span>Discovery links</span>
              <strong><a href={discoveryPreview.manifestUrl} target="_blank" rel="noreferrer">Manifest</a></strong>
              <p className="metric-line">{discoveryPreview.captureExportUrl ? <a href={discoveryPreview.captureExportUrl} target="_blank" rel="noreferrer">Capture export</a> : "Capture export unavailable"}</p>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel__header"><h2>Verifier inputs</h2></div>
        <div className="field-grid">
          <div className="field-grid__row field-grid__row--wide">
            <span>Proof package zip</span>
            <input type="file" accept=".zip,application/zip" onChange={(event) => setPackageZip(event.target.files?.[0])} />
          </div>
          <div className="field-grid__row field-grid__row--wide">
            <span>Checkpoint JSON (optional override)</span>
            <input type="file" accept="application/json,.json" onChange={(event) => setCheckpointFile(event.target.files?.[0])} />
          </div>
          <div className="field-grid__row field-grid__row--wide">
            <span>Operator public key JSON (optional override)</span>
            <input type="file" accept="application/json,.json" multiple onChange={handleKeySelection} />
          </div>
        </div>
        <p className="metric-line">
          Precedence: user-supplied checkpoint overrides the package checkpoint. User-supplied operator keys override package-provided operator key
          material. The verifier does not merge the two sources in v1.
        </p>
        <p className="metric-line">
          Browser verifier limits: max zip {formatBytes(browserVerifierLimits.maxZipBytes)}, max extracted total {formatBytes(browserVerifierLimits.maxExtractedBytes)},
          max individual file {formatBytes(browserVerifierLimits.maxIndividualFileBytes)}.
        </p>
        <div className="detail-header">
          <button onClick={verify} disabled={!packageZip || isVerifying}>{isVerifying ? "Verifying..." : "Verify package"}</button>
          <button className="ghost-button" onClick={() => packageZip && verify()} disabled={!packageZip || isVerifying}>Re-run verification</button>
        </div>
        {error ? <p className="notice notice--error">{error}</p> : null}
        {actionNotice ? <p className="notice">{actionNotice}</p> : null}
      </section>

      {report ? (
        <>
          <section className="panel verifier-result verifier-result--status">
            <div className="panel__header"><h2>Verification result</h2></div>
            <div className={`status-pill status-pill--${report.status}`}>{statusTitle(report.status)}</div>
            <p className="hero-copy">{report.summary}</p>
            <p className="metric-line"><strong>Trust basis:</strong> {report.trustBasisSummary}</p>
            <div className="detail-header">
              <button onClick={copySummary}>Copy summary</button>
              <button className="ghost-button" onClick={() => downloadJson(report)}>Download JSON report</button>
            </div>
          </section>

          <section className="panel">
            <div className="panel__header"><h2>Checks</h2></div>
            <div className="summary-grid verifier-check-grid">
              {report.checks.map((check) => (
                <div key={check.id} className="summary-card">
                  <span>{check.label}</span>
                  <strong>{check.status.toUpperCase()}</strong>
                  <p className="metric-line">{check.details}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel__header"><h2>What was trusted</h2></div>
            <div className="field-grid comparison-field-grid">
              <div className="field-grid__row">
                <span>Checkpoint source</span>
                <strong>{report.trustBasis.checkpointSource}</strong>
              </div>
              <div className="field-grid__row">
                <span>Operator key source</span>
                <strong>{report.trustBasis.operatorKeySource}</strong>
              </div>
              <div className="field-grid__row">
                <span>Independent trust root supplied by user</span>
                <strong>{report.trustBasis.independentTrustRootSuppliedByUser ? "Yes" : "No"}</strong>
              </div>
              <div className="field-grid__row">
                <span>Checkpoint ID</span>
                <strong>{report.trustBasis.checkpointId ?? "Missing"}</strong>
              </div>
              <div className="field-grid__row field-grid__row--wide">
                <span>Operator key fingerprints</span>
                <strong>{report.trustBasis.operatorKeyFingerprints.length ? report.trustBasis.operatorKeyFingerprints.join(", ") : "Missing"}</strong>
              </div>
              <div className="field-grid__row field-grid__row--wide">
                <span>Proof bundle hash</span>
                <strong>{report.trustBasis.proofBundleHash ?? "Not available"}</strong>
              </div>
            </div>
          </section>

          {report.articleSummary ? (
            <section className="panel">
              <div className="panel__header"><h2>Article summary</h2></div>
              <div className="field-grid comparison-field-grid">
                <div className="field-grid__row field-grid__row--wide"><span>Title</span><strong>{report.articleSummary.title ?? "Not available"}</strong></div>
                <div className="field-grid__row"><span>Publisher / site</span><strong>{report.articleSummary.publisher ?? "Not available"}</strong></div>
                <div className="field-grid__row"><span>Canonical URL</span><strong>{report.articleSummary.canonicalUrl ?? "Not available"}</strong></div>
                <div className="field-grid__row"><span>Published at</span><strong>{report.articleSummary.publishedAt ?? "Not available"}</strong></div>
                <div className="field-grid__row"><span>Updated at</span><strong>{report.articleSummary.updatedAt ?? "Not available"}</strong></div>
              </div>
            </section>
          ) : null}

          {report.attestations ? (
            <section className="panel">
              <div className="panel__header"><h2>Attestation summary</h2></div>
              <div className="summary-grid verifier-check-grid">
                <div className="summary-card">
                  <span>Claims present</span>
                  <strong>{report.attestations.attestationCount} attestation(s)</strong>
                  <p className="metric-line">Types: {report.attestations.attestationTypes.join(", ")}</p>
                </div>
                <div className="summary-card">
                  <span>Identity claims</span>
                  <strong>Informational only</strong>
                  <p className="metric-line">Actor and role claims are packaged attestations, not independent trust roots.</p>
                </div>
              </div>
            </section>
          ) : null}
          {report.lineage ? (
            <section className="panel">
              <div className="panel__header"><h2>Quote Lineage</h2></div>
              <div className="summary-grid verifier-check-grid">
                <div className="summary-card">
                  <span>Lineage summary</span>
                  <strong>{report.lineage.lineageNodeCount} node(s), {report.lineage.lineageEdgeCount} edge(s)</strong>
                  <p className="metric-line">Roots: {report.lineage.lineageRoots.length ? report.lineage.lineageRoots.join(", ") : "None detected"}</p>
                </div>
                <div className="summary-card">
                  <span>Trust note</span>
                  <strong>
                    {report.lineage.lineageWarnings.some((warning) => warning.code === "verbatim-text-mismatch" || warning.code === "trimmed-text-mismatch")
                      ? "Exactness warning present"
                      : "No exactness warning"}
                  </strong>
                  <p className="metric-line">
                    Lineage is package-authored provenance metadata. Semantic equivalence is only exact-proven for deterministic verbatim or excerpt checks.
                  </p>
                </div>
              </div>
              <div className="comparison-columns">
                <div className="panel panel--nested">
                  <h3>Nodes</h3>
                  {report.lineage.nodes?.length ? (
                    <div className="field-grid comparison-field-grid">
                      {report.lineage.nodes.map((node) => (
                        <div key={node.id} className="field-grid__row field-grid__row--wide">
                          <span>{node.type}</span>
                          <strong>{node.id}: {previewLineageText(node.text)}</strong>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="notice">Lineage node details were not included in this verification view.</p>
                  )}
                </div>
                <div className="panel panel--nested">
                  <h3>Derivation chain</h3>
                  {report.lineage.edges?.length ? (
                    <div className="field-grid comparison-field-grid">
                      {report.lineage.edges.map((edge) => (
                        <div key={`${edge.from}-${edge.to}-${edge.derivationType}`} className="field-grid__row field-grid__row--wide">
                          <span>{edge.derivationType}</span>
                          <strong>{edge.from} -&gt; {edge.to}</strong>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="notice">Lineage edge details were not included in this verification view.</p>
                  )}
                </div>
              </div>
              <div className="panel panel--nested">
                <h3>Warnings / trust notes</h3>
                {report.lineage.lineageWarnings.length ? (
                  <ul className="evidence-list">
                    {report.lineage.lineageWarnings.map((warning) => (
                      <li key={`${warning.code}-${warning.edgeFrom ?? warning.nodeId ?? warning.message}`}>{warning.message}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="notice">No lineage warnings were generated.</p>
                )}
              </div>
            </section>
          ) : null}

          <section className="panel">
            <div className="panel__header"><h2>Verification appendix</h2></div>
            <details className="details-card">
              <summary>Expand technical details</summary>
              <div className="comparison-columns">
                <div className="panel panel--nested">
                  <h3>Selected materials</h3>
                  <div className="field-grid comparison-field-grid">
                    <div className="field-grid__row">
                      <span>Checkpoint source</span>
                      <strong>{report.appendix.selectedCheckpointSource}</strong>
                    </div>
                    <div className="field-grid__row">
                      <span>Operator key source</span>
                      <strong>{report.appendix.selectedOperatorKeySource}</strong>
                    </div>
                    <div className="field-grid__row">
                      <span>Checkpoint hash</span>
                      <strong>{report.appendix.selectedCheckpointHash ?? "Not available"}</strong>
                    </div>
                    <div className="field-grid__row">
                      <span>Merkle root</span>
                      <strong>{report.appendix.selectedCheckpointRootHash ?? "Not available"}</strong>
                    </div>
                    <div className="field-grid__row field-grid__row--wide">
                      <span>Transparency log entry</span>
                      <strong>{report.appendix.transparencyLogEntryHash ?? "Not available"}</strong>
                    </div>
                  </div>
                </div>
                <div className="panel panel--nested">
                  <h3>Verification order</h3>
                  <ol className="evidence-list verifier-order-list">
                    <li>Verify proof package integrity.</li>
                    <li>Verify the Merkle inclusion proof.</li>
                    <li>Verify the signed checkpoint against the selected trusted operator key material.</li>
                    <li>Optionally verify the PDF approval receipt.</li>
                  </ol>
                </div>
              </div>
              <div className="comparison-columns">
                <div className="panel panel--nested">
                  <h3>Inclusion proof</h3>
                  {report.appendix.inclusionProof ? (
                    <div className="field-grid comparison-field-grid">
                      <div className="field-grid__row"><span>Mode</span><strong>{report.appendix.inclusionProof.mode}</strong></div>
                      <div className="field-grid__row"><span>Tree size</span><strong>{report.appendix.inclusionProof.treeSize}</strong></div>
                      <div className="field-grid__row"><span>Leaf index</span><strong>{report.appendix.inclusionProof.leafIndex}</strong></div>
                      <div className="field-grid__row field-grid__row--wide"><span>Root hash</span><strong>{report.appendix.inclusionProof.rootHash}</strong></div>
                    </div>
                  ) : (
                    <p className="notice">No inclusion proof details were available.</p>
                  )}
                </div>
                <div className="panel panel--nested">
                  <h3>Optional approval receipt</h3>
                  {report.appendix.approvalReceipt ? (
                    <div className="field-grid comparison-field-grid">
                      <div className="field-grid__row"><span>Receipt ID</span><strong>{report.appendix.approvalReceipt.id}</strong></div>
                      <div className="field-grid__row"><span>Approval scope</span><strong>{report.appendix.approvalReceipt.approvalScope}</strong></div>
                      <div className="field-grid__row"><span>Approval method</span><strong>{report.appendix.approvalReceipt.approvalMethod}</strong></div>
                      <div className="field-grid__row"><span>Actor account</span><strong>{report.appendix.approvalReceipt.actorAccountId}</strong></div>
                    </div>
                  ) : (
                    <p className="notice">No optional approval receipt was included.</p>
                  )}
                </div>
              </div>
              <div className="panel panel--nested">
                <h3>Package files</h3>
                <pre>{report.appendix.fileReferences.join("\n")}</pre>
              </div>
            </details>
          </section>
        </>
      ) : null}
    </div>
  );
};






