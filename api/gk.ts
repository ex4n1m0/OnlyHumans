// /api/gk — the universe key for the browser portal, served from a
// Vercel env var (OH_GK_B64 / OH_GK_VERSION, set per release by the
// release script). The portal needs the same GK the installer embeds;
// serving it from a function keeps key material out of the repository
// entirely, so a git push can never ship a stale or wrong-universe key.
// The GK is public-by-design (room access is gated by the room word) —
// this is repo hygiene, not confidentiality.
//   GET -> { version, gk_b64 }
import type { VercelRequest, VercelResponse } from "@vercel/node";

declare const process: { env: Record<string, string | undefined> };

export default function gk(_req: VercelRequest, res: VercelResponse) {
  const gkB64 = process.env.OH_GK_B64;
  const version = process.env.OH_GK_VERSION;
  if (!gkB64 || !version) {
    res.status(503).json({ error: "portal key not configured" });
    return;
  }
  // The portal revalidates on every join; a short shared cache keeps a
  // burst of tabs off a cold function without serving a stale universe
  // for long after a release.
  res.setHeader("Cache-Control", "public, max-age=60");
  res.status(200).json({ version, gk_b64: gkB64 });
}
