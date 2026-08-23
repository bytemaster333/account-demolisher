import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // this docs app sits next to the main app (two lockfiles), so Next would
  // otherwise infer the parent as the workspace root and try to compile the main
  // app's src/middleware.ts. pin the root to this directory.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
  async redirects() {
    return [
      {
        source: "/",
        destination: "/docs",
        permanent: false,
      },
    ];
  },
};

export default withMDX(config);
