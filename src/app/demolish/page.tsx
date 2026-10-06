"use client";

// orchestrator-driven demolition UI. The flow itself lives in
// _components/DemolishFlow; this file is only the route entry.

import { AppShell } from "@/components/layout/AppShell";

import { DemolishFlow } from "./_components/DemolishFlow";

export default function DemolishPage(): React.JSX.Element {
  return (
    <AppShell>
      <DemolishFlow />
    </AppShell>
  );
}
