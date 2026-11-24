/**
 * The setup page with a pad (bun test): where the focus goes next over the page's controls and over the keys, what a key
 * does to the address, and what counts as a press of the pad. No page is drawn here: the hidden run (smoke, case "hands")
 * presses a pad on the real one.
 */
import { describe, expect, test } from "bun:test";
import { AHOY_PORT, LETTERS, PadReader, QUICK, SYMBOLS, startKey, stepFrom, typeKey, type Box, type Cmd } from "../src/setup-keys";

const at = (left: number, top: number, width: number, height: number): Box => ({ left, top, right: left + width, bottom: top + height });

describe("where the focus goes on the page", () => {
  // the pane as it stands in a 1360 x 860 window: the address across, Browse and each Play at the right, Connect below
  const page = [at(928, 180, 384, 40), at(1215, 268, 97, 40), at(1236, 372, 76, 36), at(1236, 424, 76, 36), at(1213, 760, 99, 44)];
  const [FIELD, BROWSE, PLAY1, PLAY2, CONNECT] = [0, 1, 2, 3, 4];
  test("down and up walk the controls as the page reads, a wide field to a button at its right too", () => {
    expect(stepFrom(page, FIELD, "down")).toBe(BROWSE);
    expect(stepFrom(page, BROWSE, "down")).toBe(PLAY1);
    expect(stepFrom(page, PLAY1, "down")).toBe(PLAY2);
    expect(stepFrom(page, PLAY2, "down")).toBe(CONNECT);
    expect(stepFrom(page, CONNECT, "up")).toBe(PLAY2);
    expect(stepFrom(page, BROWSE, "up")).toBe(FIELD);
  });
  test("nothing beyond the ends, and nothing aside in another line", () => {
    expect(stepFrom(page, FIELD, "up")).toBe(-1);
    expect(stepFrom(page, CONNECT, "down")).toBe(-1);
    expect(stepFrom(page, BROWSE, "left")).toBe(-1);
    expect(stepFrom(page, FIELD, "right")).toBe(-1);
    expect(stepFrom(page, 9, "down")).toBe(-1);
    expect(stepFrom([], 0, "down")).toBe(-1);
  });
});

describe("where the focus goes on the keys", () => {
  // four rows of ten keys of 64 with 8 between, 52 a row; under them a row of wider keys, centred
  const grid: Box[] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 10; c++) grid.push(at(c * 72, r * 52, 64, 46));
  const widths = [64, 64, 104, 104, 104, 64, 136];
  let x = (712 - (widths.reduce((a, b) => a + b, 0) + 6 * 8)) / 2;
  const bottom = widths.map(w => { const b = at(x, 4 * 52, w, 46); x += w + 8; return b; });
  const keys = [...grid, ...bottom], key = (row: number, col: number) => row * 10 + col;
  test("one key at a time, in its row and in its column", () => {
    expect(stepFrom(keys, key(1, 4), "right")).toBe(key(1, 5));
    expect(stepFrom(keys, key(1, 4), "left")).toBe(key(1, 3));
    expect(stepFrom(keys, key(1, 4), "down")).toBe(key(2, 4));
    expect(stepFrom(keys, key(1, 4), "up")).toBe(key(0, 4));
  });
  test("a row ends at its ends: no jump to another row", () => {
    expect(stepFrom(keys, key(2, 9), "right")).toBe(-1);
    expect(stepFrom(keys, key(2, 0), "left")).toBe(-1);
    expect(stepFrom(keys, key(0, 3), "up")).toBe(-1);
  });
  test("down into the wider keys lands on the one below, and up from one comes back above it", () => {
    expect(stepFrom(keys, key(3, 0), "down")).toBe(40);                  // z: shift
    expect(stepFrom(keys, key(3, 9), "down")).toBe(46);                  // the slash: Connect
    expect(stepFrom(keys, key(3, 4), "down")).toBe(43);                  // b: the middle key
    const up = stepFrom(keys, 46, "up");
    expect(Math.floor(up / 10)).toBe(3);
    expect(up % 10).toBeGreaterThanOrEqual(8);
    expect(stepFrom(keys, 40, "right")).toBe(41);
    expect(stepFrom(keys, 46, "right")).toBe(-1);
    expect(stepFrom(keys, 43, "down")).toBe(-1);
  });
});

describe("the keyboard for an address", () => {
  test("has what an address is made of in reach: ten keys a row, the marks among the letters", () => {
    for (const rows of [LETTERS, SYMBOLS]) { expect(rows.length).toBe(4); for (const r of rows) expect([...r].length).toBe(10); }
    for (const c of "-.:/") expect(LETTERS.join("")).toContain(c);
    for (const c of "_~@%?=&#+") expect(SYMBOLS.join("")).toContain(c);
    expect(new Set(LETTERS.join("")).size).toBe(40);
    expect(new Set(SYMBOLS.join("")).size).toBe(40);
    expect(AHOY_PORT).toBe(8790);
    expect([...QUICK]).toEqual(["http://", "https://", ":8790"]);
  });
  test("a key adds its letter; back takes the last one away", () => {
    expect(typeKey("http://towe", "r")).toBe("http://tower");
    expect(typeKey("http://tower", ".")).toBe("http://tower.");
    expect(typeKey("http://tower", "back")).toBe("http://towe");
    expect(typeKey("", "back")).toBe("");
    expect(typeKey("ahoy", "A")).toBe("ahoyA");
  });
  test("how an address starts is put in front, in place of the start it had", () => {
    expect(typeKey("", "http://")).toBe("http://");
    expect(typeKey("192.168.1.20", "http://")).toBe("http://192.168.1.20");
    expect(typeKey("http://ahoy.example.com", "https://")).toBe("https://ahoy.example.com");
    expect(typeKey("https://ahoy.example.com", "http://")).toBe("http://ahoy.example.com");
    expect(typeKey("https://", "https://")).toBe("https://");
    expect(typeKey("  HTTP://tower", "https://")).toBe("https://tower");
  });
  test("the port goes at the end, in place of a port it had", () => {
    expect(typeKey("http://192.168.1.20", ":8790")).toBe("http://192.168.1.20:8790");
    expect(typeKey("http://192.168.1.20:8790", ":8790")).toBe("http://192.168.1.20:8790");
    expect(typeKey("http://192.168.1.20:80", ":8790")).toBe("http://192.168.1.20:8790");
    expect(typeKey("http://192.168.1.20:", ":8790")).toBe("http://192.168.1.20:8790");
    expect(typeKey("", ":8790")).toBe(":8790");
  });
  test("the focus starts on how an address starts while there is none, else among the letters", () => {
    expect(startKey("")).toBe("http://");
    expect(startKey("   ")).toBe("http://");
    expect(startKey("http://tower")).toBe("g");
  });
});

describe("a press of the pad", () => {
  const pad = (down: number[], axes: number[] = [0, 0]) => [{ buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i) })), axes }];
  const A = 0, B = 1, X = 2, MENU = 9, UP = 12, DOWN = 13;
  /** a reader whose window has had the focus for a look already */
  const reader = () => { const r = new PadReader(); r.read(pad([]), 0, true); return r; };
  test("a button is one press, however long it is held", () => {
    const r = reader();
    expect(r.read(pad([A]), 10, true)).toEqual(["ok"]);
    for (const t of [30, 400, 2000]) expect(r.read(pad([A]), t, true)).toEqual([]);
    expect(r.read(pad([]), 2010, true)).toEqual([]);
    expect(r.read(pad([A]), 2020, true)).toEqual(["ok"]);
  });
  test("each button is its own word", () => {
    const r = reader();
    const said: Cmd[] = [];
    for (const [i, b] of [B, X, MENU, UP].entries()) { said.push(...r.read(pad([b]), i * 100, true)); r.read(pad([]), i * 100 + 50, true); }
    expect(said).toEqual(["back", "delete", "done", "up"]);
  });
  test("a direction held steps again: after a moment, then steadily; the stick is a direction too", () => {
    const r = reader();
    expect(r.read(pad([DOWN]), 0, true)).toEqual(["down"]);
    expect(r.read(pad([DOWN]), 200, true)).toEqual([]);
    expect(r.read(pad([DOWN]), 360, true)).toEqual(["down"]);
    expect(r.read(pad([DOWN]), 400, true)).toEqual([]);
    expect(r.read(pad([DOWN]), 460, true)).toEqual(["down"]);
    r.read(pad([]), 500, true);
    expect(r.read(pad([], [0, -0.9]), 600, true)).toEqual(["up"]);
    expect(r.read(pad([], [0.3, 0.2]), 700, true)).toEqual([]);                 // a stick at rest, a little off its middle
    expect(r.read(pad([], [0.8, 0]), 800, true)).toEqual(["right"]);
  });
  test("the pad is the page's only while its window has the focus: a game's presses are not heard", () => {
    const r = new PadReader();
    for (const t of [10, 20, 30]) expect(r.read(pad([A, DOWN]), t, false)).toEqual([]);
    expect(r.seen).toBe(false);
    const was = reader();
    for (const t of [10, 20, 30]) expect(was.read(pad([A, DOWN]), t, false)).toEqual([]);
  });
  test("a button down when the window comes back was pressed for something else: it counts once let go and pressed again", () => {
    const r = reader();
    r.read(pad([]), 10, false);                                                 // the window lost the focus (a game runs)
    expect(r.read(pad([B]), 20, true)).toEqual([]);                             // back in front with B still down
    expect(r.read(pad([B]), 500, true)).toEqual([]);
    expect(r.read(pad([]), 510, true)).toEqual([]);
    expect(r.read(pad([B]), 520, true)).toEqual(["back"]);
    // and the very first look: whatever is down then is no press either
    const first = new PadReader();
    expect(first.read(pad([A]), 0, true)).toEqual([]);
    expect(first.seen).toBe(true);
  });
  test("no pads is nothing", () => {
    const r = new PadReader();
    for (const none of [null, undefined, [], [null, null]]) expect(r.read(none, 5, true)).toEqual([]);
    expect(r.seen).toBe(false);
  });
});
