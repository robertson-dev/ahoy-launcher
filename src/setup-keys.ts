/**
 * Ahoy launcher — the setup page with a pad: what a press means, where the focus goes next, and what a key of the page's
 * own keyboard does to the address. No page here: setup-pad.ts draws and listens; the tests run this as it is.
 */

export type Dir = "up" | "down" | "left" | "right";
/** what a press asks for: a step, a click, back, and on the keyboard: take the last letter away, connect */
export type Cmd = Dir | "ok" | "back" | "delete" | "done";

/* ─────────── the focus ─────────── */

/** where a control stands in the window */
export interface Box { left: number; top: number; right: number; bottom: number }

/**
 * The control one step from `from` in a direction: the nearest whose middle lies that way, one in line before one aside.
 * Left and right stay in the line (a control that shares no height with this one is another line's); up and down take
 * whatever is next, however far aside it stands (a wide field above a button at the right). -1: nothing that way.
 */
export function stepFrom(boxes: readonly Box[], from: number, dir: Dir): number {
  const a = boxes[from];
  if (!a) return -1;
  const cx = (b: Box) => (b.left + b.right) / 2, cy = (b: Box) => (b.top + b.bottom) / 2;
  const across = dir === "left" || dir === "right";
  let best = -1, least = Infinity;
  boxes.forEach((b, i) => {
    if (i === from) return;
    const ahead = dir === "up" ? cy(a) - cy(b) : dir === "down" ? cy(b) - cy(a) : dir === "left" ? cx(a) - cx(b) : cx(b) - cx(a);
    if (ahead < 4) return;
    if (across && (b.bottom <= a.top + 2 || b.top >= a.bottom - 2)) return;
    // aside: how far the two are apart across the way; nothing while one stands within the other's width
    const gap = across ? 0 : Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
    const aside = across ? Math.abs(cy(a) - cy(b)) : Math.abs(cx(a) - cx(b));
    const cost = ahead + gap * 3 + aside * 0.3;
    if (cost < least) { least = cost; best = i; }
  });
  return best;
}

/* ─────────── the keyboard ─────────── */

/** the port an Ahoy server answers on unless whoever runs it chose another */
export const AHOY_PORT = 8790;
/** the letters: what an address is made of, with its own marks in reach (a hyphen, a dot, a colon, a slash) */
export const LETTERS: readonly string[] = ["1234567890", "qwertyuiop", "asdfghjkl-", "zxcvbnm.:/"];
/** the rest an address may hold */
export const SYMBOLS: readonly string[] = ["1234567890", "-_~@%?=&#+", "!$'()*,;[]", ".:/\\\"<>^|`"];
/** whole pieces of an address, a press each: how it starts, and Ahoy's own port */
export const QUICK: readonly string[] = ["http://", "https://", `:${AHOY_PORT}`];
/** where the focus starts on the keys: on how an address starts while there is none yet, else in the middle of the letters */
export const startKey = (text: string): string => (text.trim() ? "g" : QUICK[0]!);

/**
 * What one key does to the address: the text after it.
 *   back          the last letter away
 *   http(s)://    how the address starts: put in front, in place of the start it had
 *   :8790         the port: at the end, in place of a port it had
 *   anything else is added as it is
 */
export function typeKey(text: string, key: string): string {
  if (key === "back") return text.slice(0, -1);
  if (/^https?:\/\/$/.test(key)) return key + text.replace(/^\s*(https?:\/*)?/i, "");
  if (/^:\d+$/.test(key)) return text.replace(/:\d*$/, "") + key;
  return text + key;
}

/* ─────────── the pad ─────────── */

/** a pad's buttons as the app's big screen reads them: A, B, X, Menu, the d-pad (the left stick steps too) */
const BUTTONS: Readonly<Record<number, Cmd>> = { 0: "ok", 1: "back", 2: "delete", 9: "done", 12: "up", 13: "down", 14: "left", 15: "right" };
const FIRST_REPEAT = 360, REPEAT = 100, TILT = 0.55;
export interface PadLike { buttons?: ArrayLike<{ pressed?: boolean } | null | undefined>; axes?: ArrayLike<number> }

/**
 * The pads, looked at a frame at a time: what was pressed since the last look. A button is one press however long it is
 * held, except a direction, which steps again while it is held. The pad is the page's only while its window has the focus
 * (`mine`): a window behind a game is still told every button, and one that is down when the window comes back was pressed
 * for something else, so it counts once it was let go and pressed again.
 */
export class PadReader {
  private held = new Map<Cmd, number>();
  private ours = false;
  /** was a pad seen at all (then the hints name its buttons) */
  seen = false;
  read(pads: ArrayLike<PadLike | null | undefined> | null | undefined, now: number, mine: boolean): Cmd[] {
    const down = new Set<Cmd>();
    for (let i = 0; mine && i < (pads?.length ?? 0); i++) {
      const p = pads![i];
      if (!p) continue;
      this.seen = true;
      for (const [n, cmd] of Object.entries(BUTTONS)) if (p.buttons?.[Number(n)]?.pressed === true) down.add(cmd);
      const x = p.axes?.[0] ?? 0, y = p.axes?.[1] ?? 0;
      if (x < -TILT) down.add("left"); else if (x > TILT) down.add("right");
      if (y < -TILT) down.add("up"); else if (y > TILT) down.add("down");
    }
    const out: Cmd[] = [];
    for (const c of [...this.held.keys()]) if (!down.has(c)) this.held.delete(c);
    for (const c of down) {
      const dir = c === "up" || c === "down" || c === "left" || c === "right";
      const next = this.held.get(c);
      if (next === undefined) { this.held.set(c, this.ours ? now + FIRST_REPEAT : Infinity); if (this.ours) out.push(c); }
      else if (dir && now >= next) { this.held.set(c, now + REPEAT); out.push(c); }
    }
    this.ours = mine;
    return out;
  }
}
