/// <reference types="vite/client" />

// Ambient declarations for Vite's asset-import suffixes used by the Studio app.
// `?url` returns the resolved asset URL as a string (React Router `links` href);
// a bare `.css` import is a side-effecting stylesheet include.
declare module "*.css?url" {
  const url: string;
  export default url;
}

declare module "*.css" {
  const css: string;
  export default css;
}
