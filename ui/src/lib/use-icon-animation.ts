// From the hugeicons-animated registry (shadcn: @hugeicons-animated/*), changed so the icon plays
// when its row, button or menu item is hovered, not only the 16 px glyph, and so icons render
// a bare <svg> that the primitives' `[&>svg]` size and colour rules still reach.

import type { LegacyAnimationControls } from "motion/react";
import { spring, useReducedMotion } from "motion/react";
import type { ForwardedRef, SVGProps } from "react";
import { useCallback, useEffect, useImperativeHandle, useRef } from "react";

/**
 * A damped spring as the easing of one keyframe segment: the value overshoots
 * its target and settles on it. Use it for landings so every icon shares the
 * same physical bounce. Higher `bounce` gives more oscillation.
 */
export function springEase(bounce = 0.45, visualDuration = 0.35) {
  const generator = spring({ keyframes: [0, 1], bounce, visualDuration });
  let settle = 0;
  while (!generator.next(settle).done && settle < 5000) settle += 10;
  return (progress: number) => (progress >= 1 ? 1 : generator.next(progress * settle).value);
}

const NUMBER = /-?\d*\.?\d+/g;

/**
 * The path at position `t` along a row of poses that share the same path
 * commands: `t = 1` is the second pose, `t = 1.5` is halfway to the third.
 * Waves use it to move along their own curvature instead of scaling, so the
 * stroke keeps its width.
 */
export function pathAt(poses: string[], t: number) {
  const i = Math.min(Math.max(Math.floor(t), 0), poses.length - 2);
  const to = poses[i + 1].match(NUMBER) ?? [];
  let k = 0;
  return poses[i].replace(NUMBER, (from) => {
    const value = Number(from) + (Number(to[k++]) - Number(from)) * (t - i);
    return String(Math.round(value * 10000) / 10000);
  });
}

export interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

/** Motion's own handlers clash with React's, and none of the icons need them. */
type MotionClash = "onAnimationStart" | "onDrag" | "onDragEnd" | "onDragStart" | "values";

export interface AnimatedIconProps extends Omit<SVGProps<SVGSVGElement>, "ref" | MotionClash> {
  size?: number;
  /** Play the gesture once on mount: an icon that has just swapped in, or a new alert. */
  playOnMount?: boolean;
}

/** The control whose hover plays the icon. Without one, the icon is its own target. */
const TRIGGER =
  'a[href], button, [role="button"], [role^="menuitem"], [role="option"], [role="tab"], [role="combobox"]';
const DISABLED = ':disabled, [aria-disabled="true"], [data-disabled]';

interface UseIconAnimationOptions {
  controls: LegacyAnimationControls;
  loops?: boolean;
  playOnMount?: boolean;
  ref: ForwardedRef<AnimatedIconHandle>;
}

export function useIconAnimation({
  controls,
  loops = false,
  playOnMount = false,
  ref,
}: UseIconAnimationOptions) {
  const shouldReduceMotion = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const isPlayingRef = useRef(false);
  const runRef = useRef(0);

  const startAnimation = useCallback(() => {
    if (shouldReduceMotion || isPlayingRef.current) return;

    isPlayingRef.current = true;
    const run = ++runRef.current;
    controls.set("normal");
    void controls.start("animate").then(() => {
      if (runRef.current === run) isPlayingRef.current = false;
    });
  }, [controls, shouldReduceMotion]);

  // Finite gestures finish their beat; only looping ones stop when the pointer leaves.
  const stopAnimation = useCallback(() => {
    if (!loops) return;

    runRef.current++;
    isPlayingRef.current = false;
    void controls.start("normal");
  }, [controls, loops]);

  useImperativeHandle(ref, () => ({ startAnimation, stopAnimation }), [
    startAnimation,
    stopAnimation,
  ]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const trigger: Element = svg.closest(TRIGGER) ?? svg;
    // Touch fires pointerenter on every tap; only a real hover plays the icon.
    const onEnter = (event: Event) => {
      if ((event as PointerEvent).pointerType === "touch" || trigger.matches(DISABLED)) return;
      startAnimation();
    };
    const onLeave = (event: Event) => {
      if ((event as PointerEvent).pointerType !== "touch") stopAnimation();
    };
    trigger.addEventListener("pointerenter", onEnter);
    trigger.addEventListener("pointerleave", onLeave);
    return () => {
      trigger.removeEventListener("pointerenter", onEnter);
      trigger.removeEventListener("pointerleave", onLeave);
    };
  }, [startAnimation, stopAnimation]);

  // Once per mount: a later prop change, or StrictMode's second effect run, must not replay it.
  const playOnMountRef = useRef(playOnMount);
  useEffect(() => {
    if (!playOnMountRef.current) return;
    playOnMountRef.current = false;
    startAnimation();
  }, [startAnimation]);

  return svgRef;
}
