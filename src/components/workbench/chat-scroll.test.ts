import { describe, expect, it } from "vitest";
import { isAtBottom } from "./chat-scroll";

describe("chat scroll follow policy", () => {
  it("follows changes while the viewport is at the bottom", () => {
    expect(isAtBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })).toBe(true);
    expect(isAtBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 200 })).toBe(false);
  });
});
