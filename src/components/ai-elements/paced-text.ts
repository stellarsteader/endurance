"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Text that streams in as the model sends it, shown at a steady pace. Local models send a few words at once and
 * then pause; drawing each burst as it lands makes the reply stutter. Here words are released evenly, at the rate
 * text has been arriving, and faster when the shown text falls behind, so it is never more than MAX_LAG_MS behind
 * what arrived. Text that was not streaming when it mounted (an earlier reply) shows whole at once.
 */
const MAX_LAG_MS = 300;
/** Once the reply has ended, what is left shows within this. */
const FINISH_MS = 150;
/** A run without spaces (Chinese, Japanese, a long path) is released in pieces of at most this many characters. */
const MAX_WORD = 8;
/** Renders at most this often; markdown is parsed again on each. */
const FRAME_MS = 32;

/** The end of the word that starts at `from`, with the spaces before it. */
function wordEnd(text: string, from: number) {
  let end = from;
  while (end < text.length && /\s/.test(text[end])) end++;
  const start = end;
  while (end < text.length && !/\s/.test(text[end]) && end - start < MAX_WORD) end++;
  return end;
}

export function usePacedText(text: string, live: boolean) {
  const [shown, setShown] = useState(() => (live ? 0 : text.length));
  // shown: released so far; drawn: what the last render showed.
  const pace = useRef({ shown: live ? 0 : text.length, drawn: live ? 0 : text.length, budget: 0, rate: 0, arrived: text.length, arrivedAt: 0, drawnAt: 0 });
  const latest = useRef(text);
  const wasLive = useRef(live);

  useEffect(() => {
    latest.current = text;
    const state = pace.current;
    const now = performance.now();
    // How fast text arrives, smoothed over the last few pieces.
    const added = text.length - state.arrived;
    if (added > 0 && state.arrivedAt) {
      const rate = added / Math.max(16, now - state.arrivedAt);
      state.rate = state.rate ? state.rate * 0.8 + rate * 0.2 : rate;
    }
    state.arrived = text.length;
    state.arrivedAt = now;
    // Text that was replaced, not added to, shows as it is.
    if (text.length < state.shown) {
      state.shown = state.drawn = text.length;
      setShown(text.length);
    }
    if (live) wasLive.current = true;
  }, [text, live]);

  const behind = shown < text.length;
  useEffect(() => {
    // Nothing to pace: an earlier reply, or one that has caught up and ended.
    if (!live && !behind) return;
    if (!live && !wasLive.current) {
      pace.current.shown = pace.current.drawn = latest.current.length;
      setShown(latest.current.length);
      return;
    }
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const state = pace.current;
      const full = latest.current;
      const elapsed = now - previous;
      previous = now;
      const backlog = full.length - state.shown;
      if (backlog <= 0) state.budget = 0;
      else {
        const speed = Math.max(live ? state.rate : 0, backlog / (live ? MAX_LAG_MS : FINISH_MS));
        state.budget = Math.min(backlog, state.budget + speed * elapsed);
        let next = state.shown;
        for (let end = wordEnd(full, next); next < full.length && end - next <= state.budget; end = wordEnd(full, next)) {
          state.budget -= end - next;
          next = end;
        }
        state.shown = next;
      }
      // The last piece is drawn at once, so an ended reply is never left a frame short.
      if (state.drawn !== state.shown && (now - state.drawnAt >= FRAME_MS || state.shown === full.length)) {
        state.drawn = state.shown;
        state.drawnAt = now;
        setShown(state.shown);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [live, behind]);

  return text.slice(0, Math.min(shown, text.length));
}
