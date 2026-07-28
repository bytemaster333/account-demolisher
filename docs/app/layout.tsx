import { RootProvider } from "fumadocs-ui/provider/next";
import { Inter } from "next/font/google";
import type { Metadata } from "next";
import "./global.css";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    template: "%s · Account Demolisher Docs",
    default: "Account Demolisher Docs",
  },
  description:
    "Documentation for Account Demolisher, an open-source tool for cleanly closing Stellar accounts across classic and Soroban DeFi positions.",
};

export default function Layout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
