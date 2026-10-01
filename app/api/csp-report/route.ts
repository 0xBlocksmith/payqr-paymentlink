/**
 * Where the report-only Content-Security-Policy sends its violations.
 *
 * The full policy ships in report-only mode so a directive that is too tight
 * cannot break a payment while it is being tuned (see next.config.mjs). But
 * report-only with no reporting endpoint only ever reaches the console of
 * whoever happens to have DevTools open — on a customer's phone, mid-payment,
 * nobody does, so the real traffic the policy has to survive was never being
 * seen (review item 5). This collects it into the deployment's own logs, which
 * is what the "run a flow, add any host it reports" step needs.
 *
 * Deliberately minimal: it accepts the report, logs the few fields that say
 * what to change, and answers 204. It stores nothing and trusts nothing — the
 * body is attacker-controllable (anyone can POST here), so it is only ever
 * logged, never acted on, and it is capped so the log cannot be flooded by one
 * oversized report.
 */
import { NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/** Both report formats: the legacy report-uri body and the Reporting API's. */
type LegacyReport = { "csp-report"?: Record<string, unknown> };
type ReportingApiEntry = { type?: string; body?: Record<string, unknown> };

const MAX_BODY_BYTES = 16 * 1024;
/** Enough to identify the directive and host to add; not the whole page. */
const MAX_FIELD_CHARS = 300;

function field(v: unknown): string | undefined {
  return typeof v === "string" ? v.slice(0, MAX_FIELD_CHARS) : undefined;
}

function summarize(report: Record<string, unknown>) {
  return {
    directive: field(report["effective-directive"] ?? report["effectiveDirective"] ?? report["violated-directive"]),
    blocked: field(report["blocked-uri"] ?? report["blockedURL"]),
    document: field(report["document-uri"] ?? report["documentURL"]),
    disposition: field(report["disposition"]),
  };
}

export async function POST(req: Request): Promise<Response> {
  const text = await req.text().catch(() => "");
  if (!text || text.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 204 });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const reports: Record<string, unknown>[] = Array.isArray(parsed)
    ? (parsed as ReportingApiEntry[]).filter((e) => e?.type === "csp-violation" && e.body).map((e) => e.body!)
    : [(parsed as LegacyReport)["csp-report"] ?? (parsed as Record<string, unknown>)];

  for (const report of reports.slice(0, 10)) {
    if (report && typeof report === "object") console.warn("[payqr:csp]", summarize(report));
  }
  return new NextResponse(null, { status: 204 });
}

/** Nothing to read here; a GET is a mistake or a scan. */
export async function GET(): Promise<Response> {
  return new NextResponse(null, { status: 405 });
}
