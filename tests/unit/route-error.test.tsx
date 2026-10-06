// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import RouteError from "@/app/error";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("route error boundary", () => {
  it("shows the error, logs it, and retries on request", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = vi.fn();
    const error = new RangeError("Maximum BigInt size exceeded");
    render(<RouteError error={error} retry={retry} />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByTestId("route-error-detail").textContent).toBe(
      "Maximum BigInt size exceeded",
    );
    expect(log).toHaveBeenCalledWith(error);

    fireEvent.click(screen.getByTestId("route-error-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("strips hidden characters from an error message before showing it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RouteError error={new Error("bad‮token")} retry={vi.fn()} />);
    expect(screen.getByTestId("route-error-detail").textContent).toBe("badtoken");
  });
});
