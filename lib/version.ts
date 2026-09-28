/**
 * Single source of truth for the app's user-visible version string.
 *
 * Prefer a build-injected value (`NEXT_PUBLIC_APP_VERSION`, e.g. a release tag or
 * commit SHA set in CI) so every deploy shows a real, unique version and the
 * "Check for updates" row means something. Falls back to the literal below for
 * local/dev builds where no build id is set.
 *
 * NOTE: this is the DISPLAY version. The service worker's cache name
 * (`CACHE` in public/sw.js) is what actually triggers the OTA update prompt and
 * must ALSO be bumped on each release (ideally from the same build id in CI).
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "v1.0";
