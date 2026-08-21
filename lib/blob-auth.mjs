/* How we prove to Vercel Blob that we are allowed to touch the store.
 *
 * There are two credentials, and the difference is what makes this module worth having.
 *
 * 1. **`BLOB_READ_WRITE_TOKEN`** — long-lived, and **the store id is baked inside it**. Works
 *    anywhere, including off Vercel entirely: the owner console, the portable flash drive and
 *    the maintenance scripts all rely on this and always will, because OIDC has no meaning on
 *    a laptop.
 *
 * 2. **OIDC** — short-lived and auto-rotating, which is why Vercel recommends it. The token is
 *    NOT an environment variable at function runtime: `@vercel/oidc` reads it from
 *    `x-vercel-oidc-token` on Vercel's per-request context (falling back to `VERCEL_OIDC_TOKEN`,
 *    which exists during builds). ⚠ An OIDC token carries **no store id**, so it must be paired
 *    with `BLOB_STORE_ID` — the SDK throws without one.
 *
 * ⚠ THIS IS WHY `blobConfigured()` CANNOT JUST LOOK FOR A TOKEN.
 * Under OIDC there is no blob credential in the environment at all — only `BLOB_STORE_ID`. The
 * old `Boolean(process.env.BLOB_READ_WRITE_TOKEN)` guards would therefore have reported "not
 * configured" on a perfectly healthy OIDC deployment, and every one of them fails QUIETLY:
 * the signup log simply stops recording, and the one-confirmation-per-day cap that stops this
 * endpoint being used to bomb an inbox silently turns itself off. Nothing errors. Nothing looks
 * wrong. That is the failure this module exists to prevent.
 *
 * ⚠ The presence of `BLOB_STORE_ID` is a claim that OIDC *should* work, not proof that it does —
 * a request outside Vercel's context still has no OIDC token. Reads and writes must keep
 * failing safe on their own; this only answers "is a route to the store configured at all?".
 */

/** The long-lived token, or undefined under OIDC. Pass straight to the SDK either way:
 *  an explicit token wins, and `undefined` makes the SDK resolve OIDC itself. */
export const blobToken = () => process.env.BLOB_READ_WRITE_TOKEN;

/** Is there any configured way to reach the blob store — a token, or OIDC + a store id? */
export function blobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

/** True when the ONLY route is OIDC. Useful for a startup log line that says which is in use. */
export function blobUsingOidc() {
  return !process.env.BLOB_READ_WRITE_TOKEN && Boolean(process.env.BLOB_STORE_ID);
}
