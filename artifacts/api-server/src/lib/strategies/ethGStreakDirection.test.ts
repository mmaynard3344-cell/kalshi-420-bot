import { describe, expect, it } from "vitest";
import { ethGReversalSide } from "./ethGStreakDirection.js";

describe("ETH G exact-two opposite side", () => {
  it("reverses newly formed YES streak", () => expect(ethGReversalSide("no","yes","yes")).toBe("no"));
  it("reverses newly formed NO streak", () => expect(ethGReversalSide("yes","no","no")).toBe("yes"));
  it("does not fire without two matching recent settlements", () => expect(ethGReversalSide("yes","yes","no")).toBeNull());
  it("does not fire on a streak of three", () => expect(ethGReversalSide("yes","yes","yes")).toBeNull());
  it("does not fire on a NO streak of three", () => expect(ethGReversalSide("no","no","no")).toBeNull());
});
