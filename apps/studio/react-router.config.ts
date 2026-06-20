import type { Config } from "@react-router/dev/config";

// Framework-mode config. SSR is on (the loaders/actions read through the
// StudioDataAdapter on the server; wallet/SIWE state is client-only and guarded
// behind a mounted check per RESEARCH Pitfall 6).
export default {
  ssr: true,
} satisfies Config;
