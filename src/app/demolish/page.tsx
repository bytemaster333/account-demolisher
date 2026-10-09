"use client";

// route entry for the demolish page. the flow itself lives in
// _components/DemolishFlow.

import { AppShell } from "@/components/layout/AppShell";

import { DemolishFlow } from "./_components/DemolishFlow";

export default function DemolishPage(): React.JSX.Element {
  return (
    <AppShell>
      <DemolishFlow />
    </AppShell>
  );
}
