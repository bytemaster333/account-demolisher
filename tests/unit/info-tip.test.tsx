// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  // android chrome fires these for a tap on a button: the focus lands before the
  // click, so a focus that opened the tip would let the click close it again
  it("stays open after a tap whose focus fires before the click", () => {
    const trigger = renderTip();
    fireEvent.pointerEnter(trigger, { pointerType: "touch" });
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.mouseDown(trigger);
    fireEvent.focus(trigger);
    fireEvent.mouseUp(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeNull();
  });

  it("closes on a second tap", () => {
    const trigger = renderTip();
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.focus(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("still opens on keyboard focus after an earlier tap", () => {
    const trigger = renderTip();
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.focus(trigger);
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    fireEvent.blur(trigger);
    fireEvent.focus(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeNull();
  });

  // safari on macos doesn't focus a button on press, so pressing the term and
  // dragging off before release fires no click and no blur (NP5-55)
  it("opens on a later keyboard focus after a press that was dragged off", () => {
    const trigger = renderTip();
    fireEvent.pointerDown(trigger, { pointerType: "mouse" });
    fireEvent.pointerUp(document.body, { pointerType: "mouse" });
    fireEvent.keyDown(document.body, { key: "Tab" });
    fireEvent.focus(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeNull();
  });

  it("opens on a later focus after a press that was dragged off and a click elsewhere", () => {
    const trigger = renderTip();
    fireEvent.pointerDown(trigger, { pointerType: "mouse" });
    fireEvent.pointerUp(document.body, { pointerType: "mouse" });
    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    fireEvent.focus(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeNull();
  });

  it("takes the first Escape for itself instead of letting it close a dialog", () => {
    const dialogEscape = vi.fn();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") dialogEscape();
    };
    window.addEventListener("keydown", onKey);
    try {
      const trigger = renderTip();
      fireEvent.focus(trigger);
      fireEvent.keyDown(trigger, { key: "Escape" });
      expect(screen.queryByRole("tooltip")).toBeNull();
      expect(dialogEscape).not.toHaveBeenCalled();
      fireEvent.keyDown(trigger, { key: "Escape" });
      expect(dialogEscape).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", onKey);
    }
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
