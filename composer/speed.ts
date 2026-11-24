const windowMs = 1_000;
const minimumSampleMs = 150;
const idleMs = 1_500;
const sampleEveryMs = 250;
export const sampleLimit = 24;

interface Interval {
  start: number;
  end: number;
  tokens: number;
}

export interface SpeedSnapshot {
  current: number | null;
  average: number | null;
  peak: number | null;
  streaming: boolean;
}

export interface SpeedSample {
  at: number;
  rate: number;
  segment: number;
}

export interface SpeedHistory {
  activeMs: number;
  tokens: number;
  peak: number;
  samples: readonly SpeedSample[];
}

export class SessionSpeed {
  #startedAt: number | null = null;
  #lastAt: number | null = null;
  #intervals: Interval[] = [];
  #activeMs = 0;
  #tokens = 0;
  #peak: number | null = null;
  #segment = 0;
  #samples: SpeedSample[] = [];

  constructor(history?: SpeedHistory) {
    if (!history) return;
    this.#activeMs = history.activeMs;
    this.#tokens = history.tokens;
    this.#peak = history.peak;
    this.#samples = history.samples.slice(-sampleLimit).map((sample) => ({ ...sample }));
    this.#segment = this.#samples.at(-1)?.segment ?? 0;
  }

  add(at: number, tokens: number) {
    if (!Number.isFinite(at) || !Number.isFinite(tokens) || tokens <= 0) return;
    const last = this.#lastAt;
    if (last === null || at - last >= idleMs) {
      this.end();
      this.#segment++;
      this.#startedAt = at;
      this.#lastAt = at;
      return;
    }
    if (at < last) return;
    if (at === last) {
      const latest = this.#intervals.at(-1);
      if (!latest) return;
      latest.tokens += tokens;
    } else {
      this.#intervals.push({ start: last, end: at, tokens });
      this.#lastAt = at;
    }
    const elapsed = at - (this.#startedAt ?? at);
    if (elapsed < minimumSampleMs) return;

    const firstSample = this.#samples.at(-1)?.segment !== this.#segment;
    this.#activeMs += firstSample ? elapsed : at - last;
    this.#tokens += firstSample ? this.#intervals.reduce((sum, interval) => sum + interval.tokens, 0) : tokens;
    this.#intervals = this.#intervals.filter(({ end }) => end > at - windowMs);
    const speed = this.#speedAt(at);
    if (speed !== null) this.#sample(at, speed);
  }

  addCompleted(at: number, durationMs: number, tokens: number) {
    if (!Number.isFinite(at) || !Number.isFinite(tokens) || tokens <= 0
      || !Number.isFinite(durationMs) || durationMs < minimumSampleMs || durationMs > windowMs) return;
    this.end();
    this.#segment++;
    this.#activeMs += durationMs;
    this.#tokens += tokens;
    this.#sample(at, tokens * 1000 / durationMs);
  }

  end() {
    this.#startedAt = null;
    this.#lastAt = null;
    this.#intervals = [];
  }

  read(now: number): SpeedSnapshot {
    const streaming = this.#lastAt !== null && now - this.#lastAt < idleMs;
    return {
      current: streaming ? this.#speedAt(now) : null,
      average: this.#activeMs >= minimumSampleMs ? this.#tokens * 1000 / this.#activeMs : null,
      peak: this.#peak,
      streaming,
    };
  }

  recent(): readonly SpeedSample[] {
    return this.#samples;
  }

  history(): SpeedHistory | null {
    if (this.#peak === null) return null;
    return {
      activeMs: this.#activeMs,
      tokens: this.#tokens,
      peak: this.#peak,
      samples: this.#samples.map((sample) => ({ ...sample })),
    };
  }

  #sample(at: number, speed: number) {
    this.#peak = Math.max(this.#peak ?? 0, speed);
    const previous = this.#samples.at(-1);
    if (!previous || previous.segment !== this.#segment || at - previous.at >= sampleEveryMs) {
      this.#samples.push({ at, rate: speed, segment: this.#segment });
      if (this.#samples.length > sampleLimit) this.#samples.shift();
    } else {
      previous.rate = speed;
    }
  }

  #speedAt(now: number) {
    if (this.#startedAt === null || this.#lastAt === null || this.#lastAt - this.#startedAt < minimumSampleMs) return null;
    const duration = Math.min(windowMs, now - this.#startedAt);
    if (duration < minimumSampleMs) return null;
    const since = now - duration;
    return this.#intervals.reduce((sum, interval) => {
      const overlap = Math.max(0, Math.min(now, interval.end) - Math.max(since, interval.start));
      return sum + interval.tokens * overlap / (interval.end - interval.start);
    }, 0) * 1000 / duration;
  }
}
