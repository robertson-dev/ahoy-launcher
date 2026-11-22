/**
 * A controller's home button, read from what the browser says of the pads (src/pad-edge.ts): one press is one, however long
 * it is held; a button already down when the watching starts is none; a pad the browser does not map the standard way has no
 * home button to trust.
 */
import { describe, expect, test } from "bun:test";
import { HOME, homeEdge } from "../src/pad-edge";

const pad = (down: number[], mapping = "standard") => ({ mapping, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i) })) });

describe("the home button", () => {
  test("is the standard mapping's button 16", () => { expect(HOME).toBe(16); });

  test("pressed once however long it is held; let go and pressed again, once more", () => {
    let was = false;
    const look = (pads: unknown[]) => { const r = homeEdge(was, pads as never); was = r.down; return r.pressed; };
    expect(look([pad([])])).toBe(false);
    expect(look([pad([16])])).toBe(true);
    for (let i = 0; i < 20; i++) expect(look([pad([16])])).toBe(false);          // held for a second
    expect(look([pad([])])).toBe(false);
    expect(look([pad([16])])).toBe(true);
  });

  test("already down when the watching starts: not a press, until it is let go and pressed again", () => {
    let was = true;                                                             // how the watcher starts
    const look = (pads: unknown[]) => { const r = homeEdge(was, pads as never); was = r.down; return r.pressed; };
    expect(look([pad([16])])).toBe(false);
    expect(look([pad([16])])).toBe(false);
    expect(look([pad([])])).toBe(false);
    expect(look([pad([16])])).toBe(true);
  });

  test("any other button is not it; any standard pad's home button is", () => {
    for (let i = 0; i < 16; i++) expect(homeEdge(false, [pad([i])]).pressed).toBe(false);
    expect(homeEdge(false, [null, pad([]), pad([16])]).pressed).toBe(true);
    expect(homeEdge(false, [pad([0, 1, 16])]).pressed).toBe(true);
  });

  test("a pad the browser does not map the standard way has no home button to trust", () => {
    expect(homeEdge(false, [pad([16], "")]).pressed).toBe(false);
    expect(homeEdge(false, [pad([16], "xr-standard")]).pressed).toBe(false);
  });

  test("no pads, an empty slot, a pad with fewer buttons: nothing, and nothing breaks", () => {
    expect(homeEdge(false, [])).toEqual({ down: false, pressed: false });
    expect(homeEdge(false, null)).toEqual({ down: false, pressed: false });
    expect(homeEdge(false, [null, undefined])).toEqual({ down: false, pressed: false });
    expect(homeEdge(false, [{ mapping: "standard", buttons: [{ pressed: true }] }])).toEqual({ down: false, pressed: false });
    expect(homeEdge(false, [{ mapping: "standard" }])).toEqual({ down: false, pressed: false });
  });
});
