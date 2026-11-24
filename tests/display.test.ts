/**
 * The display the window is on (bun test): what Windows says of its monitors, read into their real size and how they are
 * connected; which monitor a display is; what a page is told; when a screen is held in the hands; and how the window and
 * its smallest size are kept inside a display's work area. Nothing here asks a real PC: the answers are written out.
 */
import { describe, expect, test } from "bun:test";
import { HAND_INCHES, MONITOR_QUERY, WINDOW, boundsInside, displayInfo, inHands, inchesOf, monitorOf, panelOf, parseMonitors, windowFit, zoomOf, type Monitor } from "../src/display";

/** what the query prints: sizes in centimetres, the connection's kind, the monitor's own name */
const answer = (rows: { i: string; w: number; h: number; t?: number; n?: string; a?: boolean }[]) => JSON.stringify({
  size: rows.map(r => ({ i: r.i, a: r.a ?? true, w: r.w, h: r.h })),
  link: rows.filter(r => r.t !== undefined).map(r => ({ i: r.i, t: r.t })),
  name: rows.filter(r => r.n !== undefined).map(r => ({ i: r.i, n: r.n })),
});
const PANEL = { i: "DISPLAY\\PNL0001\\4&1&0&UID1_0", w: 15, h: 9, t: 11 };                    // a 7 inch panel on embedded DisplayPort, nameless
const TV = { i: "DISPLAY\\TVX0001\\5&2&0&UID2_0", w: 160, h: 90, t: 5, n: "Den TV" };          // HDMI
const DESK = { i: "DISPLAY\\MON0001\\5&2&0&UID3_0", w: 70, h: 39, t: 10, n: "Desk 32" };       // DisplayPort, a cable
const read = (...rows: Parameters<typeof answer>[0]) => parseMonitors(answer(rows))!;
const screen = (width: number, height: number, scaleFactor: number, internal = false, label = "") => ({ internal, label, size: { width, height }, scaleFactor });

describe("what Windows says of its monitors", () => {
  test("is read into each monitor's size, name and whether it is wired inside the PC", () => {
    expect(read(PANEL, TV)).toEqual([
      { instance: PANEL.i, name: "", widthCm: 15, heightCm: 9, internal: true },
      { instance: TV.i, name: "Den TV", widthCm: 160, heightCm: 90, internal: false },
    ]);
  });
  test("every kind of connection inside a PC counts, also when the number arrives signed", () => {
    for (const t of [0x80000000, -2147483648, 6, 11, 13]) expect(read({ ...PANEL, t })[0]!.internal).toBe(true);
    for (const t of [0, 4, 5, 10, 15]) expect(read({ ...PANEL, t })[0]!.internal).toBe(false);
    expect(read({ i: "x", w: 15, h: 9 })[0]!.internal).toBeNull();                               // Windows did not say
  });
  test("a monitor that is off is left out; one that gives no size has none", () => {
    expect(read({ ...TV, a: false }, DESK).map(m => m.name)).toEqual(["Desk 32"]);
    expect(read({ ...TV, w: 0, h: 0 })[0]).toMatchObject({ widthCm: 0, heightCm: 0 });
  });
  test("one monitor arrives as a list of one or as the thing itself; lines before the answer are passed over", () => {
    const one = JSON.stringify({ size: { i: "a", a: true, w: 15, h: 9 }, link: { i: "a", t: 11 }, name: [] });
    expect(parseMonitors(one)).toEqual([{ instance: "a", name: "", widthCm: 15, heightCm: 9, internal: true }]);
    expect(parseMonitors("a profile said hello\r\n" + answer([TV]) + "\r\n")!.length).toBe(1);
    expect(parseMonitors(JSON.stringify({ size: [], link: [], name: [] }))).toEqual([]);
  });
  test("anything that is not the answer is no answer", () => {
    for (const junk of ["", "Access denied", "{ not json", "[1,2]", "null"]) expect(parseMonitors(junk)).toBeNull();
  });
  test("the question travels as one argument: no double quote in it", () => {
    expect(MONITOR_QUERY).not.toContain('"');
    expect(MONITOR_QUERY).toContain("WmiMonitorBasicDisplayParams");
  });
});

describe("which monitor a display is", () => {
  const both = read(PANEL, TV), desk = read(TV, DESK);
  test("the only one that is on", () => {
    expect(monitorOf({ internal: false, label: "anything" }, read(PANEL))!.instance).toBe(PANEL.i);
  });
  test("the built-in one, for a display Electron calls built in", () => {
    expect(monitorOf({ internal: true, label: "" }, both)!.instance).toBe(PANEL.i);
  });
  test("the one of its name", () => {
    expect(monitorOf({ internal: false, label: "Den TV" }, desk)!.instance).toBe(TV.i);
    expect(monitorOf({ internal: false, label: "Desk 32" }, desk)!.instance).toBe(DESK.i);
  });
  test("the one left when the other displays have taken theirs (a nameless panel Electron does not call built in)", () => {
    expect(monitorOf({ internal: false, label: "" }, both, ["Den TV"])!.instance).toBe(PANEL.i);
    expect(monitorOf({ internal: false, label: "Generic PnP Monitor" }, both, ["Den TV"])!.instance).toBe(PANEL.i);
  });
  test("two of one model are the same size: either; two of one name that differ, or nothing to tell them by: none", () => {
    const twins = read(TV, { ...TV, i: "DISPLAY\\TVX0001\\5&2&0&UID9_0" }, PANEL);
    expect(monitorOf({ internal: false, label: "Den TV" }, twins, ["Den TV", ""])!.name).toBe("Den TV");
    const odd = read(TV, { ...TV, i: "other", w: 120, h: 68 });
    expect(monitorOf({ internal: false, label: "Den TV" }, odd)).toBeNull();
    expect(monitorOf({ internal: false, label: "" }, desk)).toBeNull();
  });
});

describe("what a page is told of the display", () => {
  test("a handheld's own panel: built in, 7 inches, at whatever scale Windows has it", () => {
    for (const [w, h, s] of [[1280, 720, 1.5], [1920, 1080, 1], [960, 540, 2], [1536, 864, 1.25]] as const) {
      const d = displayInfo(screen(w, h, s, true), read(PANEL));
      expect(d).toEqual({ internal: true, mm: { width: 150, height: 90 }, inches: 6.9, panel: 6.9, points: { width: w, height: h }, scale: s });
    }
  });
  test("built in by Windows' word of the connection, also where Electron does not call it so", () => {
    expect(displayInfo(screen(1280, 720, 1.5, false), read(PANEL)).internal).toBe(true);
    expect(displayInfo(screen(1280, 720, 1.5, false, ""), read(PANEL, TV), ["Den TV"])).toMatchObject({ internal: true, inches: 6.9 });
  });
  test("in its dock, on the television: plugged in, the television's size, and the PC's own panel still known", () => {
    expect(displayInfo(screen(1280, 720, 1.5, false, "Den TV"), read(PANEL, TV), [""])).toMatchObject({ internal: false, inches: 72.3, panel: 6.9 });
    // the panel switched off in the dock: Windows lists the television alone; the panel is known from an earlier run
    expect(displayInfo(screen(1280, 720, 1.5, false, "Den TV"), read(TV), [], { width: 150, height: 90 })).toMatchObject({ internal: false, inches: 72.3, panel: 6.9 });
    expect(displayInfo(screen(1280, 720, 1.5, false, "Den TV"), read(TV))).toMatchObject({ internal: false, panel: null });
  });
  test("a desktop's monitors are plugged in; a laptop's panel is built in and large", () => {
    expect(displayInfo(screen(2560, 1440, 1.5, false, "Den TV"), read(TV, DESK), ["Desk 32"])).toMatchObject({ internal: false, mm: { width: 1600, height: 900 }, panel: null });
    expect(displayInfo(screen(1707, 960, 1.5, false, "Desk 32"), read(TV, DESK), ["Den TV"])).toMatchObject({ internal: false, inches: 31.5 });
    expect(displayInfo(screen(1536, 864, 1.25, true), read({ ...PANEL, w: 31, h: 17 }))).toMatchObject({ internal: true, inches: 13.9, panel: 13.9 });
  });
  test("Windows could not be asked: nothing is called plugged in, and a built-in display has the size kept from before", () => {
    expect(displayInfo(screen(1280, 720, 1.5, false), null)).toMatchObject({ internal: null, mm: null, inches: null, panel: null });
    expect(displayInfo(screen(1280, 720, 1.5, true), null)).toMatchObject({ internal: true, inches: null });
    expect(displayInfo(screen(1280, 720, 1.5, true), null, [], { width: 150, height: 90 })).toMatchObject({ internal: true, inches: 6.9, panel: 6.9 });
    expect(displayInfo(screen(1280, 720, 1.5, false), [])).toMatchObject({ internal: null });       // an empty answer says nothing
  });
  test("a display that cannot be told from another monitor has no size, and is not called plugged in while one is built in", () => {
    expect(displayInfo(screen(1280, 720, 1.5, false, "Unknown"), read(PANEL, TV, DESK), ["Den TV"])).toMatchObject({ internal: null, mm: null, inches: null, panel: 6.9 });
    expect(displayInfo(screen(1920, 1080, 1, false, "Unknown"), read(TV, DESK))).toMatchObject({ internal: false, mm: null });
  });
  test("a monitor that gives no size: none, never a guess", () => {
    expect(displayInfo(screen(1280, 720, 1.5, true), read({ ...PANEL, w: 0, h: 0 }))).toMatchObject({ internal: true, mm: null, inches: null, panel: null });
  });
  test("the panel to keep for the next start is the one wired inside, whichever display the window is on", () => {
    expect(panelOf(screen(1280, 720, 1.5, false, "Den TV"), read(PANEL, TV), [""])).toEqual({ width: 150, height: 90 });
    expect(panelOf(screen(1280, 720, 1.5, true), read({ i: "x", w: 15, h: 9 }))).toEqual({ width: 150, height: 90 });   // Electron's word alone
    expect(panelOf(screen(2560, 1440, 1.5, false, "Den TV"), read(TV, DESK), ["Desk 32"])).toBeNull();
    expect(panelOf(screen(1280, 720, 1.5, true), null)).toBeNull();
  });
  test("a diagonal in inches, to a tenth", () => {
    expect(inchesOf({ width: 150, height: 90 })).toBe(6.9);
    expect(inchesOf({ width: 190, height: 120 })).toBe(8.8);
    expect(inchesOf({ width: 120, height: 190 })).toBe(8.8);                                      // a panel mounted on its side
    expect(inchesOf({ width: 0, height: 90 })).toBeNull();
    expect(inchesOf(null)).toBeNull();
  });
});

describe("a screen held in the hands", () => {
  const info = (internal: boolean | null, inches: number | null, height: number) => ({ internal, inches, points: { width: Math.round(height * 16 / 9), height } });
  test("is a built-in panel under about ten inches, whatever Windows' scale, touch screen or not", () => {
    expect(HAND_INCHES).toBe(9.5);
    for (const lines of [540, 720, 864, 1080]) expect(inHands(info(true, 6.9, lines), false)).toBe(true);
    expect(inHands(info(true, 8.8, 1067), true)).toBe(true);
    expect(inHands(info(true, 9.7, 800), true)).toBe(false);                                      // a 10.1 inch laptop, rounded down
    expect(inHands(info(true, 13.9, 768), true)).toBe(false);                                     // a small touch laptop: short, but no handheld
  });
  test("never a display that is plugged in, however short and whatever the PC", () => {
    expect(inHands(info(false, 72.3, 720), true)).toBe(false);
    expect(inHands(info(false, null, 720), true)).toBe(false);
  });
  test("where the size is not known: a PC with a touch screen and a display at most 800 points tall", () => {
    expect(inHands(info(null, null, 720), true)).toBe(true);
    expect(inHands(info(true, null, 800), true)).toBe(true);
    expect(inHands(info(null, null, 720), false)).toBe(false);
    expect(inHands(info(null, null, 1080), true)).toBe(false);
  });
});

describe("the window on its display", () => {
  test("is 1360 × 860 and no smaller than 980 × 640 where there is room", () => {
    expect(WINDOW).toEqual({ width: 1360, height: 860, minWidth: 980, minHeight: 640 });
    expect(windowFit({ width: 2560, height: 1392 })).toEqual({ width: 1360, height: 860, minWidth: 980, minHeight: 640 });
    expect(windowFit({ width: 1920, height: 1032 })).toEqual({ width: 1360, height: 860, minWidth: 980, minHeight: 640 });
  });
  test("is never larger than the work area, nor may its smallest size be", () => {
    expect(windowFit({ width: 1280, height: 672 })).toEqual({ width: 1280, height: 672, minWidth: 980, minHeight: 640 });   // 1080 lines at 150%
    expect(windowFit({ width: 1097, height: 569 })).toEqual({ width: 1097, height: 569, minWidth: 980, minHeight: 569 });   // at 175%
    expect(windowFit({ width: 960, height: 492 })).toEqual({ width: 960, height: 492, minWidth: 960, minHeight: 492 });     // at 200%
    expect(windowFit({ width: 853.3, height: 432.4 })).toEqual({ width: 853, height: 432, minWidth: 853, minHeight: 432 });
  });
  test("a work area nobody knows changes nothing", () => {
    for (const none of [null, undefined, { width: 0, height: 0 }, { width: NaN, height: NaN }]) expect(windowFit(none as never)).toEqual({ ...WINDOW });
  });
  test("a window larger than the display it came to is put inside it; one that fits keeps its size", () => {
    const small = { x: 0, y: 0, width: 960, height: 492 };
    expect(boundsInside({ x: 200, y: 100, width: 1360, height: 860 }, small)).toEqual({ x: 0, y: 0, width: 960, height: 492 });
    const second = { x: 1920, y: 0, width: 1280, height: 672 };
    expect(boundsInside({ x: 2100, y: 40, width: 1360, height: 860 }, second)).toEqual({ x: 1920, y: 0, width: 1280, height: 672 });
    expect(boundsInside({ x: 100, y: 80, width: 1100, height: 700 }, { x: 0, y: 0, width: 2560, height: 1392 })).toEqual({ x: 100, y: 80, width: 1100, height: 700 });
  });
  test("a window smaller than it may be on the display it came to grows to the smallest size there", () => {
    expect(boundsInside({ x: 300, y: 200, width: 960, height: 492 }, { x: 0, y: 0, width: 2560, height: 1392 })).toEqual({ x: 300, y: 200, width: 980, height: 640 });
    expect(boundsInside({ x: 2000, y: 1000, width: 960, height: 492 }, { x: 0, y: 0, width: 2560, height: 1392 })).toEqual({ x: 1580, y: 752, width: 980, height: 640 });
  });
});

describe("the page's zoom", () => {
  test("goes from a half to four times; what is no number is the page's own size", () => {
    expect(zoomOf(1.5)).toBe(1.5);
    expect(zoomOf(0.75)).toBe(0.75);
    expect(zoomOf(0.1)).toBe(0.5);
    expect(zoomOf(0)).toBe(0.5);
    expect(zoomOf(9)).toBe(4);
    for (const odd of ["big", NaN, undefined, {}, Infinity]) expect(zoomOf(odd)).toBe(1);
    expect(zoomOf("1.2")).toBe(1.2);
  });
});
