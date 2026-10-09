// @vitest-environment happy-dom

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useMachine } from "@xstate/react";
import { fromPromise } from "xstate";

import { EMPTY_POSITIONS } from "@/lib/adapters/positions/interface";
import { MAINNET, TESTNET, type NetworkConfig } from "@/lib/config/networks";
import { pageFlowMachine, type PageFlowInput } from "@/lib/orchestrator/page-flow-machine";
import type { PlanTree } from "@/lib/plan/tree";
import type { AccountAudit } from "@/lib/types/account";

import { runMismatch, useRunGuard } from "@/app/demolish/_hooks/use-run-guard";

afterEach(cleanup);

const ORIGINAL = "GORIGINALACCOUNT";
const OTHER = "GOTHERACCOUNT";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function machineWithStubs(discoverGate: Promise<void>) {
  return pageFlowMachine.provide({
    actors: {
      discover: fromPromise(async () => {
        await discoverGate;
        return {
          audit: { accountId: ORIGINAL } as unknown as AccountAudit,
          positions: EMPTY_POSITIONS,
          allowances: [],
          heldTokens: [],
          unreadableHeldTokens: [],
          heldTokenScanFailed: false,
          discoveryWarnings: [],
        };
      }) as never,
      preview: fromPromise(async () => ({
        tree: { allNodes: new Map(), roots: [] } as unknown as PlanTree,
        unroutableCredits: [],
        heldTokenWarnings: [],
      })) as never,
      // runs until the close is interrupted, then reports it the way the real
      // executor does at a step boundary
      execute: fromPromise(
        async ({ input }: { input: { tree: PlanTree; interrupt: AbortSignal } }) => {
          await new Promise((resolve) => input.interrupt.addEventListener("abort", resolve));
          return {
            result: { ok: false, errors: ["The close was stopped."] },
            tree: input.tree,
            notes: [],
            leftBehind: [],
            landedPhases: [],
            failureKind: "interrupted",
          };
        },
      ) as never,
    },
  });
}

function Harness(props: {
  readonly machine: ReturnType<typeof machineWithStubs>;
  readonly publicKey: string | null;
  readonly network: NetworkConfig;
}) {
  const [snapshot, send] = useMachine(props.machine);
  useRunGuard({
    state: String(snapshot.value),
    input: snapshot.context.input,
    publicKey: props.publicKey,
    networkId: props.network.id,
    send,
  });
  return (
    <>
      <output data-testid="state">{String(snapshot.value)}</output>
      <button
        type="button"
        data-testid="start"
        onClick={() =>
          send({
            type: "START",
            input: {
              publicKey: ORIGINAL,
              network: MAINNET,
              connector: {},
              destination: "GDESTINATIONXXXX",
              useMediator: false,
            } as unknown as PageFlowInput,
          })
        }
      />
      {/* a CONFIRM with the right last-4 of the destination the run was built for */}
      <button
        type="button"
        data-testid="confirm"
        onClick={() =>
          send({
            type: "CONFIRM",
            typed: "XXXX",
            expected: { publicKey: ORIGINAL, networkId: MAINNET.id },
          })
        }
      />
    </>
  );
}

describe("runMismatch", () => {
  const input = { publicKey: ORIGINAL, network: MAINNET } as unknown as PageFlowInput;
  it("is false with no run", () => {
    expect(runMismatch(null, OTHER, "testnet")).toBe(false);
  });
  it("flags a different account, a different network, or a disconnect", () => {
    expect(runMismatch(input, ORIGINAL, "mainnet")).toBe(false);
    expect(runMismatch(input, OTHER, "mainnet")).toBe(true);
    expect(runMismatch(input, ORIGINAL, "testnet")).toBe(true);
    expect(runMismatch(input, null, "mainnet")).toBe(true);
  });
});

describe("a plan built for one network or account is discarded when either changes (H-31)", () => {
  it("cancels when the network switches and the wallet reconnects during discovery", async () => {
    const gate = deferred<void>();
    const machine = machineWithStubs(gate.promise);
    const { rerender } = render(
      <Harness machine={machine} publicKey={ORIGINAL} network={MAINNET} />,
    );
    act(() => screen.getByTestId("start").click());
    expect(screen.getByTestId("state").textContent).toBe("discovering");

    // navbar switch to testnet, then a different wallet connects, all before the
    // preview finishes: publicKey is non-null again by the time it lands
    rerender(<Harness machine={machine} publicKey={null} network={TESTNET} />);
    rerender(<Harness machine={machine} publicKey={OTHER} network={TESTNET} />);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("state").textContent).toBe("cancelled");

    // a CONFIRM against the discarded plan does nothing
    act(() => screen.getByTestId("confirm").click());
    expect(screen.getByTestId("state").textContent).toBe("cancelled");
  });

  it("keeps the plan when the same account reconnects on the same network", async () => {
    const gate = deferred<void>();
    const machine = machineWithStubs(gate.promise);
    const { rerender } = render(
      <Harness machine={machine} publicKey={ORIGINAL} network={MAINNET} />,
    );
    act(() => screen.getByTestId("start").click());
    rerender(<Harness machine={machine} publicKey={ORIGINAL} network={MAINNET} />);
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("state").textContent).toBe("awaiting_confirmation");
  });
});

describe("a close that is executing stops when the wallet or network changes (M-10)", () => {
  it("interrupts the run at the next step boundary once the wallet disconnects", async () => {
    const gate = deferred<void>();
    gate.resolve();
    const machine = machineWithStubs(gate.promise);
    const { rerender } = render(
      <Harness machine={machine} publicKey={ORIGINAL} network={MAINNET} />,
    );
    act(() => screen.getByTestId("start").click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("state").textContent).toBe("awaiting_confirmation");
    act(() => screen.getByTestId("confirm").click());
    expect(screen.getByTestId("state").textContent).toBe("executing");

    rerender(<Harness machine={machine} publicKey={null} network={MAINNET} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("state").textContent).toBe("failed");
  });
});
