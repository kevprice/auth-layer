# Quote Lineage

Quote lineage is an optional provenance layer for proof packages. It lets a package describe how one content object derives from another without changing the existing trust boundary.

## What it is for

Quote lineage helps answer questions like:
- did this quote come verbatim from the original source?
- was it trimmed from a longer source segment?
- did a later article headline or summary derive from an earlier excerpt?
- is a paraphrase or translation linked back to a captured source segment?

## Core model

### Content objects

Each lineage bundle contains generic content objects such as:
- quote
- transcript segment
- excerpt
- article snippet
- headline
- summary
- claim

A content object may include:
- id
- type
- text
- language
- sourceRef
- contextBefore
- contextAfter
- speaker
- capturedAt
- locationInSource
- metadata

### Derivation edges

Edges connect content objects in a DAG. V1 derivation types are:
- verbatim
- trimmed
- paraphrased
- headline
- summary
- excerpt
- translation

Each edge may also record who declared it, when it was created, and transform notes or metadata.

## Verification semantics

Lineage is packaged and hashed like other proof-package artifacts, so verifiers can say:
- package integrity verified
- lineage metadata present
- lineage graph valid or invalid
- lineage warnings present

But verifiers must not overclaim semantic truth.

### Stronger deterministic cases
- `verbatim`: can be checked for exact text equality
- `trimmed` and `excerpt`: can be checked as exact substrings of the parent text

### Provenance-only cases
- `paraphrased`
- `headline`
- `summary`
- `translation`

These can be provenance-verified, but semantic equivalence is not proven by v1 deterministic checks.

## Example

```json
{
  "schemaVersion": 1,
  "bundleType": "auth-layer-lineage-bundle",
  "subject": "centcom-quote-example",
  "contentObjects": [
    {
      "id": "transcript-root",
      "type": "transcript-segment",
      "text": "The canonical content, proof bundle, and receipt should all verify offline.",
      "language": "en",
      "speaker": "Speaker name",
      "contextBefore": "This capture exists so we can export a portable proof package.",
      "contextAfter": "The transparency log entry and checkpoint should also be included."
    },
    {
      "id": "trimmed-quote",
      "type": "quote",
      "text": "proof bundle, and receipt should all verify offline",
      "language": "en"
    },
    {
      "id": "headline-version",
      "type": "headline",
      "text": "Proof bundle verifies offline",
      "language": "en"
    }
  ],
  "edges": [
    {
      "from": "transcript-root",
      "to": "trimmed-quote",
      "derivationType": "trimmed",
      "declaredBy": { "displayName": "Auth Layer demo" }
    },
    {
      "from": "trimmed-quote",
      "to": "headline-version",
      "derivationType": "headline",
      "declaredBy": { "displayName": "Auth Layer demo" }
    }
  ],
  "rootObjectIds": ["transcript-root"]
}
```

## Trust note

Cryptographic provenance is not the same as semantic identity. A package can verifiably preserve a paraphrase lineage chain without proving that the paraphrase is an exact restatement of the original wording.
