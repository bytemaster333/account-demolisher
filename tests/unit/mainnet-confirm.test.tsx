// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MainnetConfirm } from "@/components/layout/MainnetConfirm";

afterEach(cleanup);

describe("MainnetConfirm", () => {
  it("renders as a modal dialog carrying the real-funds warning", () => {
    render(<MainnetConfirm onConfirm={() => {}} onCancel={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("Switch to Mainnet?")).toBeTruthy();
    expect(screen.getByTestId("mainnet-confirm-confirm").textContent).toContain(
      "Switch to Mainnet",
    );
  });

  it("confirming (after acknowledging the audit notice) calls onConfirm and never onCancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<MainnetConfirm onConfirm={onConfirm} onCancel={onCancel} />);
    // the confirm CTA is gated behind the unaudited-status acknowledgement
    fireEvent.click(screen.getByTestId("mainnet-audit-ack"));
    fireEvent.click(screen.getByTestId("mainnet-confirm-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("gates the confirm CTA on acknowledging the unaudited-status notice", () => {
    const onConfirm = vi.fn();
    render(<MainnetConfirm onConfirm={onConfirm} onCancel={() => {}} />);
    const confirm = screen.getByTestId("mainnet-confirm-confirm") as HTMLButtonElement;
    // notice is present and the CTA is disabled until it is acknowledged
    expect(screen.getByTestId("mainnet-audit-notice")).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    // ticking the acknowledgement enables it
    fireEvent.click(screen.getByTestId("mainnet-audit-ack"));
    expect(confirm.disabled).toBe(false);
  });

  it('"Stay on Testnet" calls onCancel and never onConfirm', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<MainnetConfirm onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("mainnet-confirm-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Escape cancels (stays on the safer network)", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<MainnetConfirm onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("clicking the backdrop cancels, but clicking the panel does not", () => {
    const onCancel = vi.fn();
    render(<MainnetConfirm onConfirm={() => {}} onCancel={onCancel} />);
    // clicking the panel content must NOT cancel
    fireEvent.click(screen.getByText("Switch to Mainnet?"));
    expect(onCancel).not.toHaveBeenCalled();
    // clicking the backdrop (the dialog element itself) cancels
    fireEvent.click(screen.getByTestId("mainnet-confirm"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
