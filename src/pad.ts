/**
 * Ahoy launcher — the page side of the pad watcher: a window that is never shown (main.ts watchPad) looks at the pads a few
 * times a second and tells the main process when a home button is pressed. The browser tells a page of the pads whether or
 * not its window is in front, which is the point: the button works from inside a game.
 */
import { ipcRenderer } from "electron";
import { homeEdge } from "./pad-edge";

let was = true;                                           // a button already down when the watching starts is not a press
setInterval(() => {
  let pads: ReturnType<Navigator["getGamepads"]> = [];
  try { pads = navigator.getGamepads(); } catch { /* no pads on this page */ }
  const r = homeEdge(was, pads);
  was = r.down;
  if (r.pressed) ipcRenderer.send("pad:home");
}, 50);
