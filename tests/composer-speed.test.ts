import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionSpeed } from "../composer/speed.ts";
import { composerSlot } from "../composer/layout.ts";

test("current and peak use a one-second window, and the session average weights active time", () => {
  const speed = new SessionSpeed();
  speed.add(0, 10);
  speed.add(500, 50);
  speed.add(1000, 50);
  speed.add(1800, 80);
  assert.deepEqual(speed.read(1800), { current: 100, average: 100, peak: 100, streaming: true });
  speed.add(2300, 100);
  const faster = speed.read(2300);
  assert.equal(faster.current, 150);
  assert.equal(faster.peak, 150);
  assert(Math.abs(faster.average! - 280 / 2.3) < 0.0001);
  speed.end();
  assert.equal(speed.read(2500).current, null);
  assert.equal(speed.read(2500).peak, 150);
});

test("pauses and the first fragment of each output do not inflate the reported rates", () => {
  const speed = new SessionSpeed();
  speed.add(100, 400);
  assert.deepEqual(speed.read(100), { current: null, average: null, peak: null, streaming: true });
  speed.add(600, 50);
  speed.add(1100, 50);
  assert.equal(speed.read(2600).current, null);
  speed.add(3500, 300);
  speed.add(4000, 25);
  speed.add(4500, 25);
  assert.deepEqual(speed.read(4500), { current: 50, average: 75, peak: 100, streaming: true });
});

test("a short stream produces a measurement and reopening restores it as a completed sample", () => {
  const speed = new SessionSpeed();
  speed.add(0, 200);
  assert.equal(speed.read(1100).current, null, "one fragment cannot establish a rate");
  speed.add(160, 16);
  speed.add(320, 24);
  assert.deepEqual(speed.read(320), { current: 125, average: 125, peak: 125, streaming: true });
  const history = speed.history();
  assert(history);
  const reopened = new SessionSpeed(history);
  assert.deepEqual(reopened.read(0), { current: null, average: 125, peak: 125, streaming: false });
  assert.equal(reopened.recent().at(-1)?.rate, 125);
  const previousSegment = reopened.recent().at(-1)?.segment;
  reopened.add(10, 200);
  reopened.add(210, 20);
  assert.notEqual(reopened.recent().at(-1)?.segment, previousSegment);
  assert.equal(reopened.read(210).average, 60 / 0.52);
});

test("a burst without a usable timing sample does not lower the saved session average", () => {
  const speed = new SessionSpeed();
  speed.add(0, 4);
  speed.add(500, 50);
  speed.end();
  speed.add(600, 20);
  speed.add(650, 2);
  speed.end();
  assert.equal(speed.read(650).average, 100);
});

test("the speed trend is bounded and keeps a separate segment after an output pause", () => {
  const speed = new SessionSpeed();
  const other = new SessionSpeed();
  speed.add(0, 5);
  speed.add(500, 50);
  assert.equal(speed.recent().at(-1)?.at, 500);
  speed.add(1_000, 50);
  speed.add(1_050, 15);
  speed.add(1_300, 50);
  assert.deepEqual(speed.recent().map(({ at }) => at), [500, 1_000, 1_300]);
  speed.end();
  speed.add(3_000, 5);
  speed.add(3_500, 25);
  speed.add(4_000, 25);
  const samples = speed.recent();
  assert.notEqual(samples[0].segment, samples.at(-1)?.segment);
  assert.equal(samples.at(-1)?.rate, 50);
  assert.deepEqual(other.recent(), []);
  for (let at = 4_300; at <= 13_000; at += 300) speed.add(at, 25);
  assert.equal(speed.recent().length, 24);
  assert.equal(speed.recent().at(-1)?.at, 13_000);
});

test("both buttons occupy the widest footer gap when space permits", () => {
  const box = (left: number, right: number, top = 96, bottom = 124) => ({ left, right, top, bottom });
  const composer = box(0, 540, 0, 134);
  const row = [box(10, 38), box(44, 128), box(300, 330), box(335, 511), box(32, 120, 10, 30)];
  assert.deepEqual(composerSlot(composer, row, 110), { left: 168, top: 95, speedWidth: 88, usageWidth: 30 });
  assert.deepEqual(composerSlot(composer, [box(10, 38), box(44, 128), box(350, 520)], 110),
    { left: 137, top: 95, speedWidth: 90, usageWidth: 109 });
  assert.deepEqual(composerSlot(composer, [box(10, 38), box(44, 128), box(378, 520)], 110),
    { left: 136, top: 95, speedWidth: 94, usageWidth: 134 });
  assert.deepEqual(composerSlot(composer, [box(10, 38), box(44, 128), box(220, 520)], 110),
    { left: 146, top: 95, speedWidth: 30, usageWidth: 30 });
  assert.deepEqual(composerSlot(composer, [box(10, 38), box(44, 128), box(182, 520)], 110),
    { left: 142, top: 95, speedWidth: 32, usageWidth: 0 });
  assert.equal(composerSlot(composer, [box(10, 38), box(44, 128), box(142, 511)], 110), null);
});
