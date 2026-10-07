"use client";

// route error boundary. a render error anywhere below the root layout (a row
// built from hostile on-chain data, say) lands here instead of blanking the
// whole page with the framework's bare error screen. the error is logged and
// its message shown, so nothing is hidden, and the user can try again.

import Link from "next/link";
import { useEffect } from "react";

import { Button, Card, Notice, PageContainer, PageHeader } from "@/components/ui";
import { safeDisplay } from "@/lib/safe-display";

function describe(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    const digest = (error as Error & { digest?: string }).digest;
    return digest !== undefined ? `${error.message} (${digest})` : error.message;
  }
  return String(error);
}

export default function RouteError({
  error,
  retry,
}: {
  readonly error: unknown;
  readonly retry: () => void;
}): React.JSX.Element {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageContainer>
      <PageHeader kicker="Something went wrong" title="This page couldn't be shown" />
      <Card padding={24} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Notice tone="danger" role="alert" title="The page stopped with an error">
          Try again, or go back to the start. If a close was running, check the account on the
          explorer before starting another one.
          <code
            data-testid="route-error-detail"
            style={{
              display: "block",
              marginTop: 10,
              font: "500 12px/1.5 'Geist Mono', monospace",
              wordBreak: "break-word",
            }}
          >
            {safeDisplay(describe(error))}
          </code>
        </Notice>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <Button onClick={retry} data-testid="route-error-retry">
            Try again
          </Button>
          <Link href="/" style={{ fontSize: 13.5, color: "var(--accent)" }}>
            Back to the start
          </Link>
        </div>
      </Card>
    </PageContainer>
  );
}
