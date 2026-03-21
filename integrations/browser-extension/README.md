# Browser Extension v1.1

This extension is a thin discovery and preview layer for existing authenticity proof materials.

It now supports:
- manifest detection on the current page
- clearer popup copy that separates discovery materials from claims
- explicit material availability states for manifest, capture export, and transparency entry
- a configurable verifier URL via the options page
- direct open/download actions for manifest and capture export materials when they are exposed

It does not:
- sign content
- create captures
- replace offline verification
- act as a trust anchor

One-line framing:

> The extension does not prove authenticity. It reveals where proof material exists.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the `integrations/browser-extension` folder.

## Configure verifier URL

1. Open the extension popup.
2. Click `Extension options`.
3. Set the verifier URL you want the popup to open for deeper inspection.
4. Use `Reset to default` to return to the local verifier default.

## Current behavior

- Green badge: proof materials detected
- Grey badge: no authenticity manifest detected
- Yellow badge: manifest found but preview details could not be loaded

The popup distinguishes:
- manifest found
- capture export found
- transparency entry found
- workflow / identity claims present

It can link to:
- the configured browser verifier
- manifest JSON
- capture export JSON
- transparency entry when exposed by the backend

## Limitations

- v1.1 still does not run full offline verification inside the extension
- manifest/export preview depends on network access, fetchability, and page CORS behavior
- identity and workflow claims remain informational unless independently verified
- proof package download is only shown when a real backend URL exists; the extension does not invent one
