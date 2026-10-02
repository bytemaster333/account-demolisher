// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { InfoTip } from "@/components/ui/InfoTip";

afterEach(cleanup);

function renderTip() {
  render(<InfoTip tip="what this means">term</InfoTip>);
  return screen.getByRole("button", { name: "term" });
}

describe("InfoTip", () => {
  it("closes on Escape", () => {
    const trigger = renderTip();
    fireEvent.focus(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("stays open after a tap that also fires pointer enter", () => {
    const trigger = renderTip();
    fireEvent.pointerEnter(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeNull();
  });

  it("opens and closes on mouse hover", () => {
    const trigger = renderTip();
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).not.toBeNull();
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("follows its term when the page scrolls", () => {
    const trigger = renderTip();
    let top = 200;
    trigger.getBoundingClientRect = () =>
      ({
        top,
        left: 50,
        width: 20,
        height: 10,
        right: 70,
        bottom: top + 10,
        x: 50,
        y: top,
      }) as DOMRect;
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip").style.top).toBe("192px");
    top = 120;
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByRole("tooltip").style.top).toBe("112px");
  });
});
