# WordPress Publishing Integration v1

1. Copy `auth-layer-authenticity.php` into your WordPress plugins directory.
2. Define these constants in `wp-config.php`:

```php
define('AUTH_LAYER_BASE_URL', 'https://your-auth-layer-host');
define('AUTH_LAYER_TOKEN', 'optional-shared-secret');
define('AUTH_LAYER_SITE_IDENTIFIER', 'example-newsroom');
define('AUTH_LAYER_APPROVAL_POLICY', 'none');
```

3. Activate the plugin.
4. Publish or update a post normally.
5. The plugin sends deterministic post payloads to the Auth Layer backend and injects `<link rel="authenticity-manifest" ...>` on the public page.

If approval policy requires step-up approval, the backend returns a challenge id instead of immediately queueing the package. v1 stores that challenge id in post meta so a future admin UI can complete it.

Supported approval policies:
- `none`: publish without step-up approval
- `passkey-on-publish`: require approval on first publish
- `passkey-on-update`: require approval on later updates
- `passkey-on-all`: require approval for both publish and update

When approval is required, the plugin stores the pending challenge on the post, shows an editor notice, and exposes a small `Authenticity` admin screen where an editor can complete the approval.
