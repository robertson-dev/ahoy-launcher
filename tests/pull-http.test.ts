import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpPull, PART_EXT, type HttpSource } from "../src/pull/pull-http";

const made: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ahoy-pull-")); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const SIZE = 200_000;
const bytes = new Uint8Array(SIZE); for (let i = 0; i < SIZE; i++) bytes[i] = (i * 31 + (i >> 8)) & 255;
const source: HttpSource = {
  stat: async () => ({ size: SIZE, isDir: false }),
  list: async () => [],
  request: async () => ({ url: "http://files.test/game.bin" }),
};
const range = (init?: RequestInit) => { const m = /bytes=(\d+)-(\d+)/.exec(String((init?.headers as Record<string, string>)?.range)); return [Number(m![1]), Number(m![2])] as const; };
const whole = (init?: RequestInit) => { const [a, b] = range(init); return new Response(bytes.slice(a, b + 1), { status: 206 }); };
const pull = (dir: string, fetchImpl: typeof fetch, over: { retries?: number } = {}) =>
  startHttpPull({ remotePath: "game.bin", isDir: false, expectedBytes: SIZE }, source, { downloadsDir: dir, segments: 2, minSegmentBytes: 1000, fetchImpl, sleep: async () => {}, ...over });

describe("segmented pull", () => {
  test("a segment that gives up stops its sibling: nothing is written, and no sidecar saved, after the pull has reported", async () => {
    const dir = tmp();
    let chunks = 0;
    const fetchImpl = (async (_u: any, init?: RequestInit) => {
      const [a, b] = range(init);
      if (a === 0) return new Response("no", { status: 500 });             // the first half never works
      // the second half trickles in, a little every few ms, for far longer than the first half takes to give up
      let at = a;
      return new Response(new ReadableStream({
        async pull(c) {
          await Bun.sleep(5);
          if (at > b) { c.close(); return; }
          c.enqueue(bytes.slice(at, Math.min(b + 1, at + 500))); at += 500; chunks++;
        },
      }), { status: 206 });
    }) as typeof fetch;
    const res = await pull(dir, fetchImpl, { retries: 1 }).done;
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/HTTP 500/);                                 // the failure, not "cancelled"
    const part = readFileSync(join(dir, "game.bin" + PART_EXT), "utf8");
    const file = readFileSync(join(dir, "game.bin"));
    expect(JSON.parse(part).segs[1].done).toBeLessThan(SIZE / 2);          // it was stopped, it did not finish
    await Bun.sleep(300);
    // the sibling stopped with it: the file and its sidecar are as the pull left them
    expect(Buffer.compare(readFileSync(join(dir, "game.bin")), file)).toBe(0);
    expect(readFileSync(join(dir, "game.bin" + PART_EXT), "utf8")).toBe(part);
    expect(chunks).toBeLessThan(40);
  });

  test("a sidecar whose file is gone starts the file again instead of failing every time", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "game.bin" + PART_EXT), JSON.stringify({ size: SIZE, segs: [{ start: 0, end: SIZE / 2, done: 4000 }, { start: SIZE / 2, end: SIZE, done: 100 }] }));
    const res = await pull(dir, (async (_u: any, init?: RequestInit) => whole(init)) as typeof fetch).done;
    expect(res).toMatchObject({ ok: true, bytes: SIZE });
    expect(Buffer.compare(readFileSync(join(dir, "game.bin")), Buffer.from(bytes))).toBe(0);
    expect(existsSync(join(dir, "game.bin" + PART_EXT))).toBe(false);
  });

  test("a sidecar that does not add up (a segment past its end, a gap, a negative count) is not believed", async () => {
    for (const segs of [
      [{ start: 0, end: SIZE / 2, done: SIZE }, { start: SIZE / 2, end: SIZE, done: 0 }],
      [{ start: 0, end: 1000, done: 1000 }, { start: SIZE / 2, end: SIZE, done: 10 }],
      [{ start: 0, end: SIZE / 2, done: -5 }, { start: SIZE / 2, end: SIZE, done: 10 }],
    ]) {
      const dir = tmp();
      writeFileSync(join(dir, "game.bin"), new Uint8Array(SIZE));          // zeroes where the sidecar claims finished bytes
      writeFileSync(join(dir, "game.bin" + PART_EXT), JSON.stringify({ size: SIZE, segs }));
      const res = await pull(dir, (async (_u: any, init?: RequestInit) => whole(init)) as typeof fetch).done;
      expect(res).toMatchObject({ ok: true, bytes: SIZE });
      expect(Buffer.compare(readFileSync(join(dir, "game.bin")), Buffer.from(bytes))).toBe(0);
    }
  });

  test("a good sidecar is still resumed: only the missing bytes are asked for", async () => {
    const dir = tmp();
    const half = SIZE / 2;
    const have = new Uint8Array(SIZE); have.set(bytes.subarray(0, half)); have.set(bytes.subarray(half, half + 30_000), half);
    writeFileSync(join(dir, "game.bin"), have);
    writeFileSync(join(dir, "game.bin" + PART_EXT), JSON.stringify({ size: SIZE, segs: [{ start: 0, end: half, done: half }, { start: half, end: SIZE, done: 30_000 }] }));
    const asked: number[] = [];
    const res = await pull(dir, (async (_u: any, init?: RequestInit) => { asked.push(range(init)[0]); return whole(init); }) as typeof fetch).done;
    expect(res.ok).toBe(true);
    expect(asked).toEqual([half + 30_000]);
    expect(Buffer.compare(readFileSync(join(dir, "game.bin")), Buffer.from(bytes))).toBe(0);
  });

  test("drops that each got somewhere do not add up to giving up; tries in a row that get nowhere still do", async () => {
    const dir = tmp();
    // every answer carries 10 000 bytes and then ends early: ten drops per segment, far more than the 2 tries allowed in a row
    const dripping = (async (_u: any, init?: RequestInit) => { const [a, b] = range(init); return new Response(bytes.slice(a, Math.min(b + 1, a + 10_000)), { status: 206 }); }) as typeof fetch;
    const res = await pull(dir, dripping, { retries: 2 }).done;
    expect(res).toMatchObject({ ok: true, bytes: SIZE });
    expect(Buffer.compare(readFileSync(join(dir, "game.bin")), Buffer.from(bytes))).toBe(0);
    let tries = 0;
    const dead = (async () => { tries++; return new Response(new Uint8Array(0), { status: 206 }); }) as unknown as typeof fetch;
    const res2 = await pull(tmp(), dead, { retries: 2 }).done;
    expect(res2.ok).toBe(false);
    expect(tries).toBeLessThanOrEqual(6);
  });
});
