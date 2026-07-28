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

  it("confirming calls onConfirm and never onCancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<MainnetConfirm onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("mainnet-confirm-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
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
