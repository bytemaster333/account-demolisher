// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Progress } from "@/components/ui/feedback";
import { AuthImmutableBlock } from "@/components/warnings/AuthImmutableBlock";
import { SponsoringBlock } from "@/components/warnings/SponsoringBlock";

afterEach(cleanup);

function describedText(el: HTMLElement): string {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}

describe("Progress", () => {
  it("names the progressbar after its visible label", () => {
    render(<Progress value={1} max={3} label="Signing weight collected" valueLabel="1 of 3" />);
    expect(screen.getByRole("progressbar", { name: "Signing weight collected" })).toBeTruthy();
  });
});

describe("Field", () => {
  it("links its label to the input", () => {
    render(<Field label="Destination" value="" onChange={() => {}} />);
    expect(screen.getByLabelText("Destination").tagName).toBe("INPUT");
  });

  it("marks the input invalid and points it at the error", () => {
    render(<Field aria-label="Address" value="x" onChange={() => {}} error="Not valid" />);
    const input = screen.getByLabelText("Address");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(input)).toBe("Not valid");
  });
});

describe("Button", () => {
  it("exposes the disabled reason to assistive tech, not only as a title", () => {
    render(
      <Button disabled disabledReason="Collect enough signatures first">
        Close
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Close" });
    expect(describedText(btn)).toBe("Collect enough signatures first");
  });
});

describe("blocking screens", () => {
  it("auth-immutable is a labelled region, not a modal dialog", () => {
    render(<AuthImmutableBlock onDismiss={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    const region = screen.getByTestId("auth-immutable-block");
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-modal")).toBeNull();
    expect(region.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("sponsoring is a labelled region, not a modal dialog", () => {
    render(<SponsoringBlock numSponsoring={3} coverable={1} onDismiss={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("sponsoring-block").getAttribute("role")).toBe("region");
  });
});

describe("SponsoringBlock copy", () => {
  it("counts sponsored ledger entries, not accounts, with real plurals", () => {
    render(<SponsoringBlock numSponsoring={3} coverable={1} onDismiss={() => {}} />);
    const text = screen.getByTestId("sponsoring-block").textContent ?? "";
    expect(text).toMatch(/2 ledger entries/);
    expect(text).not.toMatch(/\(s\)/);
    expect(text).not.toMatch(/OTHER account/);
  });

  it("uses the singular for one entry", () => {
    render(<SponsoringBlock numSponsoring={2} coverable={1} onDismiss={() => {}} />);
    const text = screen.getByTestId("sponsoring-block").textContent ?? "";
    expect(text).toMatch(/1 ledger entry /);
  });

  it("never shows a negative count", () => {
    render(<SponsoringBlock numSponsoring={1} coverable={4} onDismiss={() => {}} />);
    expect(screen.getByTestId("sponsoring-block-count").textContent).toBe("0");
  });
});
