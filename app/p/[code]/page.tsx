/**
 * Short payment-link route.
 *
 * `/pay/0x<64 hex>` is 66 characters of path for 32 bytes of id. This route is
 * the same page reached by `/p/<43 chars base64url>` — same bytes, denser
 * alphabet, shorter QR. See encodeLinkId in lib/paymentLinks.ts.
 *
 * The OLD route stays: links are printed on posters and shared in chat, and one
 * already in the world must keep working forever. Both paths render the same
 * component, which accepts either spelling of the id.
 */
export { default } from "../../pay/[linkId]/page";
