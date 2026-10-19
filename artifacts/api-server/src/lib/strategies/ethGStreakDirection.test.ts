import assert from "node:assert/strict";
import { test } from "node:test";
import { ethGReversalSide } from "./ethGStreakDirection.js";

test("newly formed YES streak predicts NO", () => assert.equal(ethGReversalSide("no","yes","yes"), "no"));
test("newly formed NO streak predicts YES", () => assert.equal(ethGReversalSide("yes","no","no"), "yes"));
test("unmatched recent outcomes do not trigger", () => assert.equal(ethGReversalSide("yes","yes","no"), null));
test("three YES settlements do not trigger", () => assert.equal(ethGReversalSide("yes","yes","yes"), null));
test("three NO settlements do not trigger", () => assert.equal(ethGReversalSide("no","no","no"), null));
