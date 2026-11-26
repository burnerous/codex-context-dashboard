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

test("three footer metrics use the widest gap and compress progressively", () => {
  const box = (left: number, right: number, top = 96, bottom = 124) => ({ left, right, top, bottom });
  const composer = box(0, 700, 0, 134);
  const slotForSpan = (span: number) => composerSlot(composer,
    [box(10, 38), box(44, 128), box(128 + span, 700)], 110);

  assert.deepEqual(slotForSpan(385),
    { left: 211, top: 95, speedWidth: 94, usageWidth: 134, contextWidth: 62 });
  assert.deepEqual(slotForSpan(286),
    { left: 144, top: 95, speedWidth: 94, usageWidth: 134, contextWidth: 30 });
  assert.deepEqual(slotForSpan(261),
    { left: 144, top: 95, speedWidth: 94, usageWidth: 109, contextWidth: 30 });
  assert.deepEqual(slotForSpan(180),
    { left: 148, top: 95, speedWidth: 88, usageWidth: 30, contextWidth: 30 });
  assert.deepEqual(slotForSpan(118),
    { left: 144, top: 95, speedWidth: 30, usageWidth: 30, contextWidth: 30 });
});

test("three footer controls stay within the gap with native and inter-control spacing", () => {
  const box = (left: number, right: number, top = 96, bottom = 124) => ({ left, right, top, bottom });
  const surface = box(0, 700, 0, 134);
  for (const span of [385, 286, 261, 180, 118]) {
    const gapStart = 128;
    const gapEnd = gapStart + span;
    const slot = composerSlot(surface, [box(10, 38), box(44, gapStart), box(gapEnd, 700)], 110);
    assert(slot);

    const speedEnd = slot.left + slot.speedWidth;
    const usageStart = speedEnd + 2;
    const usageEnd = usageStart + slot.usageWidth;
    const contextStart = usageEnd + 2;
    const contextEnd = contextStart + slot.contextWidth;
    assert(slot.left >= gapStart + 8);
    assert.equal(contextEnd, gapEnd - 8);
    assert.equal(usageStart - speedEnd, 2);
    assert.equal(contextStart - usageEnd, 2);
  }
});

test("context falls back to the existing two-button and single-speed tiers below its minimum", () => {
  const box = (left: number, right: number, top = 96, bottom = 124) => ({ left, right, top, bottom });
  const composer = box(0, 700, 0, 134);
  const slotForSpan = (span: number) => composerSlot(composer,
    [box(10, 38), box(44, 128), box(128 + span, 700)], 110);

  assert.deepEqual(slotForSpan(109),
    { left: 167, top: 95, speedWidth: 30, usageWidth: 30, contextWidth: 0 });
  assert.deepEqual(slotForSpan(60),
    { left: 148, top: 95, speedWidth: 32, usageWidth: 0, contextWidth: 0 });
  assert.equal(slotForSpan(47), null);
  assert.equal(composerSlot(composer, [box(10, 38), box(44, 128), box(128, 700)], 110), null);
});
