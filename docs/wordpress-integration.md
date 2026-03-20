# WordPress Publishing Integration v1

The WordPress integration keeps the existing trust model intact:
- proof packages, checkpoints, and operator public keys remain the only verifier trust anchors
- author/editor identity is packaged as attested metadata only
- offline verification still works with the proof package, checkpoint, and operator key alone

## Publish flow

1. A WordPress post is published or updated.
2. The plugin builds a deterministic article payload from WordPress post data.
3. The backend queues an `article-publish` capture and derives canonical article content from that payload.
4. Optional publish/update/approval attestations are added to `attestations.json`.
5. The proof bundle is logged and exposed through a discovery manifest.

## Discovery

Published pages can expose:

```html
<link rel="authenticity-manifest" href="https://operator.example/api/discovery/articles/https%3A%2F%2Fexample.com%2Fstory" />
```

The discovery manifest points to the latest capture export and transparency entry for the canonical article URL.

## Approval model

Passkey approval is optional and policy-gated. In v1 it is implemented as a challenge/complete seam for the plugin/backend flow:
- `publish` and `update` attestations can be session-backed
- `approval` attestations can be marked passkey-backed
- these claims are additive provenance only and are not verifier trust roots

## API endpoints

- `POST /api/integrations/wordpress/articles`
- `POST /api/integrations/wordpress/approvals/:id/complete`
- `GET /api/discovery/articles/:encodedCanonicalUrl`

## Package shape

Article packages use `artifactType: "article-publish"` and carry:
- deterministic canonical content and metadata derived from the WordPress post payload
- optional attestation bundle
- optional revision lineage when a previous packaged article version exists

## Admin approval workflow`r`n`r`nThe reference plugin now exposes a small WordPress admin screen for posts awaiting authenticity approval and adds an editor notice with a direct completion link. This keeps the v1.5 workflow close to: publish, approve if required, done.`r`n`r`n## Limitations

- v1 targets standard post publish/update flows, not custom editorial workflows or multisite edge cases
- featured images are referenced as article metadata only
- the passkey flow is an integration seam, not a full standalone WebAuthn identity system

