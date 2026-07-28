import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <span style={{ fontWeight: 600, letterSpacing: "-0.02em" }}>Account Demolisher</span>,
      url: "/",
    },
    githubUrl: "https://github.com/bytemaster333/account-demolisher",
    links: [
      {
        text: "Live app",
        url: "https://demolisher.app",
        external: true,
      },
    ],
  };
}
