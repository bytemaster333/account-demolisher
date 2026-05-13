import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Account Demolisher",
  description:
    "Cleanly close (drain and merge) a Stellar account with classic + Soroban + DeFi support.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
