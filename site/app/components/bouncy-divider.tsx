"use client";

import { useCallback, useEffect, useRef } from "react";

export function BouncyDivider() {
  const pathRef = useRef<SVGPathElement>(null);
  const frameRef = useRef<number | null>(null);
  const previousYRef = useRef<number | null>(null);
  const progressRef = useRef(0);
  const xRef = useRef(0.5);
  const timeRef = useRef(Math.PI / 2);

  const setPath = useCallback((progress: number) => {
    const path = pathRef.current;
    const width =
      path?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    path?.setAttribute(
      "d",
      `M0 20 Q${width * xRef.current} ${20 + progress}, ${width} 20`,
    );
  }, []);

  const reset = useCallback(() => {
    timeRef.current = Math.PI / 2;
    progressRef.current = 0;
    setPath(0);
  }, [setPath]);

  function animateOut() {
    const progress = progressRef.current;
    setPath(progress * Math.sin(timeRef.current));
    progressRef.current = progress * 0.975;
    timeRef.current += 0.2;

    if (Math.abs(progressRef.current) > 0.75) {
      frameRef.current = requestAnimationFrame(animateOut);
    } else {
      reset();
    }
  }

  useEffect(() => {
    setPath(0);
    const svg = pathRef.current?.parentElement;
    const observer = svg
      ? new ResizeObserver(() => setPath(progressRef.current))
      : null;
    if (svg) observer?.observe(svg);

    return () => {
      observer?.disconnect();
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [setPath]);

  return (
    <div
      className="bouncy-divider"
      aria-hidden="true"
      onMouseEnter={(event) => {
        previousYRef.current = event.clientY;
        if (frameRef.current) cancelAnimationFrame(frameRef.current);
      }}
      onMouseMove={(event) => {
        const path = pathRef.current;
        if (!path) return;
        const bounds = path.getBoundingClientRect();
        const previousY = previousYRef.current ?? event.clientY;
        previousYRef.current = event.clientY;
        xRef.current = (event.clientX - bounds.left) / bounds.width;
        progressRef.current += event.clientY - previousY;
        setPath(progressRef.current);
      }}
      onMouseLeave={() => {
        previousYRef.current = null;
        animateOut();
      }}
    >
      <svg>
        <path ref={pathRef} fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
    </div>
  );
}
