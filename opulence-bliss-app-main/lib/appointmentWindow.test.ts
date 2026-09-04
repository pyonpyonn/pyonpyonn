import assert from "node:assert/strict";
import test from "node:test";
import {
  appointmentFitsWindow,
  londonDate,
  londonParts,
} from "./appointmentWindow";

test("7:00 am is the earliest valid start", () => {
  assert.equal(appointmentFitsWindow(londonDate(2026, 8, 12, 7), 90), true);
  assert.equal(appointmentFitsWindow(londonDate(2026, 8, 12, 6, 59), 90), false);
});

test("a visit must finish by 7:00 pm", () => {
  assert.equal(appointmentFitsWindow(londonDate(2026, 8, 12, 17), 120), true);
  assert.equal(appointmentFitsWindow(londonDate(2026, 8, 12, 18), 120), false);
});

test("London wall-clock construction follows BST and GMT", () => {
  assert.equal(londonDate(2026, 8, 12, 7).toISOString(), "2026-08-12T06:00:00.000Z");
  assert.equal(londonDate(2026, 12, 12, 7).toISOString(), "2026-12-12T07:00:00.000Z");
  assert.equal(londonParts("2026-08-12T18:00:00.000Z").hour, 19);
});
