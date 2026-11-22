/**
 * Ahoy launcher — a controller's home button (the Xbox button, the PS button), read from what the browser says of the pads.
 * No imports: the watcher's page (pad.ts) is a sandboxed preload, and the tests run this as it is.
 */

/** the home button of a pad the browser maps the standard way */
export const HOME = 16;

export interface PadLike { mapping?: string; buttons?: ArrayLike<{ pressed?: boolean } | null | undefined> }

/**
 * One look at the pads. `was`: a home button was down at the last look. It is pressed when one is down now and none was: a
 * button held is one press, and one already down when the watching starts is none (start with `was` true). Only pads the
 * browser maps the standard way count: on any other, button 16 is whatever that pad happens to put there.
 */
export function homeEdge(was: boolean, pads: ArrayLike<PadLike | null | undefined> | null | undefined): { down: boolean; pressed: boolean } {
  let down = false;
  for (let i = 0; i < (pads?.length ?? 0); i++) {
    const p = pads![i];
    if (p && p.mapping === "standard" && p.buttons?.[HOME]?.pressed === true) down = true;
  }
  return { down, pressed: down && !was };
}
