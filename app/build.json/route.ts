/** The id of the build being served. The app compares it with the id baked into
 *  the bundle it is running, so "Check for updates" can tell a newer deploy
 *  exists even before the new service worker has finished installing. */
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(JSON.stringify({ id: process.env.NEXT_PUBLIC_BUILD_ID || "dev" }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0" },
  });
}
