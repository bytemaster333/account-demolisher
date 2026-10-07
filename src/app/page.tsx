"use client";

// landing page: ported from design/extracted/account demolisher.dc.html (lines 112-491).
// each section lives in src/components/landing; their copy is in landing-data.ts

import { useEffect } from "react";

import { AllowanceCallout } from "@/components/landing/AllowanceCallout";
import { Coverage } from "@/components/landing/Coverage";
import { Docs } from "@/components/landing/Docs";
import { DryRun } from "@/components/landing/DryRun";
import { Faq } from "@/components/landing/Faq";
import { Framing } from "@/components/landing/Framing";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Integrations } from "@/components/landing/Integrations";
import {
  ALL_WALLETS,
  faqsFor,
  stepsFor,
  walletConnectEnabled,
} from "@/components/landing/landing-data";
import { Security } from "@/components/landing/Security";
import { AppShell } from "@/components/layout/AppShell";
import { trackVisit } from "@/lib/metrics/beacon";

export default function HomePage(): React.JSX.Element {
  const walletConnect = walletConnectEnabled();
  const steps = stepsFor(walletConnect);
  const faqs = faqsFor(walletConnect);
  const wallets = ALL_WALLETS.filter((w) => walletConnect || w.name !== "WalletConnect");

  useEffect(() => {
    trackVisit("landing");
  }, []);

  return (
    <AppShell>
      {/* overflow-x: clip is a safety net for mobile: it stops any residual
          horizontal overflow from scrolling the page, without breaking the
          sticky header (clip, unlike hidden, sets up no scroll container) */}
      <div style={{ overflowX: "clip" }}>
        <Hero />
        <Framing />
        <Coverage />
        <HowItWorks steps={steps} />
        <DryRun />
        <Security />
        <Integrations wallets={wallets} />
        <AllowanceCallout />
        <Faq faqs={faqs} />
        <Docs />
      </div>
    </AppShell>
  );
}
