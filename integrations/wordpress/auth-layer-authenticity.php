<?php
/**
 * Plugin Name: Auth Layer Authenticity
 * Description: Sends WordPress publish and update events to an Auth Layer backend and injects authenticity manifest discovery links.
 * Version: 0.1.0
 */

if (!defined('ABSPATH')) {
    exit;
}

const AUTH_LAYER_META_MANIFEST_URL = '_auth_layer_manifest_url';
const AUTH_LAYER_META_PENDING_CHALLENGE = '_auth_layer_pending_challenge_id';

function auth_layer_base_url(): string {
    return rtrim((string) (defined('AUTH_LAYER_BASE_URL') ? AUTH_LAYER_BASE_URL : ''), '/');
}

function auth_layer_token(): string {
    return (string) (defined('AUTH_LAYER_TOKEN') ? AUTH_LAYER_TOKEN : '');
}

function auth_layer_site_identifier(): string {
    return (string) (defined('AUTH_LAYER_SITE_IDENTIFIER') ? AUTH_LAYER_SITE_IDENTIFIER : get_bloginfo('name'));
}

function auth_layer_approval_policy(): string {
    return (string) (defined('AUTH_LAYER_APPROVAL_POLICY') ? AUTH_LAYER_APPROVAL_POLICY : 'none');
}

function auth_layer_headers(): array {
    $headers = ['Content-Type' => 'application/json'];
    if (auth_layer_token() !== '') {
        $headers['Authorization'] = 'Bearer ' . auth_layer_token();
    }
    return $headers;
}

function auth_layer_build_payload(int $post_id): ?array {
    $post = get_post($post_id);
    if (!$post || $post->post_type !== 'post' || $post->post_status !== 'publish') {
        return null;
    }

    $author = get_userdata((int) $post->post_author);
    $featured_image_id = get_post_thumbnail_id($post_id);
    $featured_image_url = $featured_image_id ? wp_get_attachment_url($featured_image_id) : null;

    return [
        'schemaVersion' => 1,
        'siteIdentifier' => auth_layer_site_identifier(),
        'siteUrl' => home_url('/'),
        'postId' => (string) $post_id,
        'revisionId' => null,
        'publishedUrl' => get_permalink($post_id),
        'canonicalUrl' => wp_get_canonical_url($post_id) ?: get_permalink($post_id),
        'title' => get_the_title($post_id),
        'bodyHtml' => (string) $post->post_content,
        'excerpt' => has_excerpt($post_id) ? get_the_excerpt($post_id) : null,
        'authorDisplayName' => $author ? $author->display_name : null,
        'publishedAt' => get_post_time(DATE_ATOM, true, $post_id),
        'updatedAt' => get_post_modified_time(DATE_ATOM, true, $post_id),
        'categories' => wp_get_post_categories($post_id, ['fields' => 'names']),
        'tags' => wp_get_post_tags($post_id, ['fields' => 'names']),
        'featuredImageUrl' => $featured_image_url,
        'language' => get_bloginfo('language')
    ];
}

function auth_layer_send_article(int $post_id, string $action): void {
    $base_url = auth_layer_base_url();
    if ($base_url === '') {
        return;
    }

    $article = auth_layer_build_payload($post_id);
    if (!$article) {
        return;
    }

    $author = wp_get_current_user();
    $body = [
        'article' => $article,
        'action' => $action,
        'approval' => [
            'policy' => auth_layer_approval_policy(),
            'actor' => [
                'id' => $author->user_email ?: (string) $author->ID,
                'displayName' => $author->display_name,
                'organization' => get_bloginfo('name'),
                'role' => user_can($author, 'edit_others_posts') ? 'editor' : 'author'
            ]
        ]
    ];

    $response = wp_remote_post($base_url . '/api/integrations/wordpress/articles', [
        'headers' => auth_layer_headers(),
        'body' => wp_json_encode($body),
        'timeout' => 15
    ]);

    if (is_wp_error($response)) {
        update_post_meta($post_id, AUTH_LAYER_META_PENDING_CHALLENGE, '');
        return;
    }

    $decoded = json_decode((string) wp_remote_retrieve_body($response), true);
    if (!is_array($decoded)) {
        return;
    }

    if (!empty($decoded['manifestUrl'])) {
        update_post_meta($post_id, AUTH_LAYER_META_MANIFEST_URL, esc_url_raw($base_url . $decoded['manifestUrl']));
    }
    if (($decoded['status'] ?? '') === 'approval_required' && !empty($decoded['challengeId'])) {
        update_post_meta($post_id, AUTH_LAYER_META_PENDING_CHALLENGE, sanitize_text_field($decoded['challengeId']));
    } else {
        delete_post_meta($post_id, AUTH_LAYER_META_PENDING_CHALLENGE);
    }
}

function auth_layer_on_transition(string $new_status, string $old_status, WP_Post $post): void {
    if ($new_status === 'publish' && $old_status !== 'publish') {
        auth_layer_send_article((int) $post->ID, 'publish');
    }
}
add_action('transition_post_status', 'auth_layer_on_transition', 10, 3);

function auth_layer_on_post_updated(int $post_id, WP_Post $post_after, WP_Post $post_before): void {
    if ($post_after->post_status === 'publish' && $post_before->post_status === 'publish') {
        auth_layer_send_article($post_id, 'update');
    }
}
add_action('post_updated', 'auth_layer_on_post_updated', 10, 3);

function auth_layer_emit_manifest_link(): void {
    if (!is_single()) {
        return;
    }

    $post_id = get_queried_object_id();
    $manifest_url = get_post_meta($post_id, AUTH_LAYER_META_MANIFEST_URL, true);
    if ($manifest_url) {
        echo '<link rel="authenticity-manifest" href="' . esc_url($manifest_url) . '" />' . "\n";
    }
}
add_action('wp_head', 'auth_layer_emit_manifest_link');

function auth_layer_current_actor_claim(): array {
    $user = wp_get_current_user();
    return [
        'id' => $user->user_email ?: (string) $user->ID,
        'displayName' => $user->display_name,
        'organization' => get_bloginfo('name'),
        'role' => user_can($user, 'edit_others_posts') ? 'editor' : 'author'
    ];
}

function auth_layer_complete_pending_approval(int $post_id): bool {
    $base_url = auth_layer_base_url();
    $challenge_id = (string) get_post_meta($post_id, AUTH_LAYER_META_PENDING_CHALLENGE, true);
    if ($base_url === '' || $challenge_id === '') {
        return false;
    }

    $response = wp_remote_post($base_url . '/api/integrations/wordpress/approvals/' . rawurlencode($challenge_id) . '/complete', [
        'headers' => auth_layer_headers(),
        'body' => wp_json_encode([
            'challengeId' => $challenge_id,
            'actor' => auth_layer_current_actor_claim()
        ]),
        'timeout' => 15
    ]);

    if (is_wp_error($response)) {
        return false;
    }

    $decoded = json_decode((string) wp_remote_retrieve_body($response), true);
    if (!is_array($decoded) || ($decoded['status'] ?? '') !== 'queued') {
        return false;
    }

    if (!empty($decoded['manifestUrl'])) {
        update_post_meta($post_id, AUTH_LAYER_META_MANIFEST_URL, esc_url_raw($base_url . $decoded['manifestUrl']));
    }
    delete_post_meta($post_id, AUTH_LAYER_META_PENDING_CHALLENGE);
    return true;
}

function auth_layer_handle_complete_approval(): void {
    if (!current_user_can('edit_posts')) {
        wp_die('You are not allowed to complete authenticity approvals.');
    }

    $post_id = isset($_GET['post_id']) ? (int) $_GET['post_id'] : 0;
    check_admin_referer('auth-layer-complete-' . $post_id);
    $ok = $post_id > 0 ? auth_layer_complete_pending_approval($post_id) : false;
    $redirect = admin_url('admin.php?page=auth-layer-authenticity&approval=' . ($ok ? 'success' : 'error'));
    wp_safe_redirect($redirect);
    exit;
}
add_action('admin_post_auth_layer_complete_approval', 'auth_layer_handle_complete_approval');

function auth_layer_register_admin_page(): void {
    add_menu_page(
        'Authenticity approvals',
        'Authenticity',
        'edit_posts',
        'auth-layer-authenticity',
        'auth_layer_render_admin_page',
        'dashicons-shield-alt'
    );
}
add_action('admin_menu', 'auth_layer_register_admin_page');

function auth_layer_render_admin_page(): void {
    if (!current_user_can('edit_posts')) {
        return;
    }

    $pending_posts = get_posts([
        'post_type' => 'post',
        'post_status' => 'publish',
        'meta_query' => [[
            'key' => AUTH_LAYER_META_PENDING_CHALLENGE,
            'compare' => 'EXISTS'
        ]],
        'numberposts' => 50
    ]);

    echo '<div class="wrap"><h1>Authenticity approvals</h1>';
    if (isset($_GET['approval'])) {
        $status = sanitize_text_field((string) $_GET['approval']);
        if ($status === 'success') {
            echo '<div class="notice notice-success"><p>Authenticity approval completed and the proof package was queued.</p></div>';
        } elseif ($status === 'error') {
            echo '<div class="notice notice-error"><p>Authenticity approval could not be completed.</p></div>';
        }
    }

    if (!$pending_posts) {
        echo '<p>No posts are awaiting authenticity approval.</p></div>';
        return;
    }

    echo '<table class="widefat striped"><thead><tr><th>Post</th><th>Challenge</th><th>Manifest</th><th>Action</th></tr></thead><tbody>';
    foreach ($pending_posts as $post) {
        $challenge_id = (string) get_post_meta($post->ID, AUTH_LAYER_META_PENDING_CHALLENGE, true);
        $manifest_url = (string) get_post_meta($post->ID, AUTH_LAYER_META_MANIFEST_URL, true);
        $action_url = wp_nonce_url(
            admin_url('admin-post.php?action=auth_layer_complete_approval&post_id=' . (int) $post->ID),
            'auth-layer-complete-' . (int) $post->ID
        );
        echo '<tr>';
        echo '<td><a href="' . esc_url(get_edit_post_link($post->ID)) . '">' . esc_html(get_the_title($post->ID)) . '</a></td>';
        echo '<td><code>' . esc_html($challenge_id) . '</code></td>';
        echo '<td>' . ($manifest_url ? '<a href="' . esc_url($manifest_url) . '">manifest</a>' : '<span>Pending</span>') . '</td>';
        echo '<td><a class="button button-primary" href="' . esc_url($action_url) . '">Complete approval</a></td>';
        echo '</tr>';
    }
    echo '</tbody></table></div>';
}

function auth_layer_pending_approval_notice(): void {
    $screen = function_exists('get_current_screen') ? get_current_screen() : null;
    if (!$screen || $screen->base !== 'post') {
        return;
    }

    $post_id = isset($_GET['post']) ? (int) $_GET['post'] : 0;
    if ($post_id <= 0) {
        return;
    }

    $challenge_id = (string) get_post_meta($post_id, AUTH_LAYER_META_PENDING_CHALLENGE, true);
    if ($challenge_id === '') {
        return;
    }

    $action_url = wp_nonce_url(
        admin_url('admin-post.php?action=auth_layer_complete_approval&post_id=' . $post_id),
        'auth-layer-complete-' . $post_id
    );
    echo '<div class="notice notice-warning"><p>This post is awaiting authenticity approval. <a href="' . esc_url($action_url) . '">Complete approval now</a>.</p></div>';
}
add_action('admin_notices', 'auth_layer_pending_approval_notice');

