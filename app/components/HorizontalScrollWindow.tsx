import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type HorizontalScrollWindowProps = {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  contentWidthPercent: number;
  label: string;
  overlay?: ReactNode;
  resetKey: string;
};

export function HorizontalScrollWindow({
  ariaLabel,
  children,
  className = "",
  contentWidthPercent,
  label,
  overlay,
  resetKey,
}: HorizontalScrollWindowProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({
    backward: false,
    forward: false,
  });

  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const maximum = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    setScrollState({
      backward: viewport.scrollLeft > 2,
      forward: viewport.scrollLeft < maximum - 2,
    });
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    viewport.scrollLeft = 0;
    updateScrollState();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateScrollState);
    observer?.observe(viewport);
    observer?.observe(content);
    window.addEventListener("resize", updateScrollState);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateScrollState);
    };
  }, [contentWidthPercent, resetKey, updateScrollState]);

  const scroll = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({
      left: direction * viewport.clientWidth * 0.85,
      behavior: "smooth",
    });
  };

  return (
    <div
      className={[
        "forecast-scroll-window",
        scrollState.backward ? "can-scroll-backward" : "",
        scrollState.forward ? "can-scroll-forward" : "",
        className,
      ].filter(Boolean).join(" ")}
    >
      <div className="forecast-scroll-toolbar">
        <span>{label}</span>
        <div aria-label="Forecast timeline navigation">
          <button
            type="button"
            disabled={!scrollState.backward}
            onClick={() => scroll(-1)}
            aria-label="Show earlier forecast dates"
            title="Earlier dates"
          >
            ←
          </button>
          <button
            type="button"
            disabled={!scrollState.forward}
            onClick={() => scroll(1)}
            aria-label="Show later forecast dates"
            title="Later dates"
          >
            →
          </button>
        </div>
      </div>
      {overlay ? (
        <div className="forecast-scroll-overlay">{overlay}</div>
      ) : null}
      <div
        ref={viewportRef}
        className="forecast-scroll-viewport"
        onScroll={updateScrollState}
        tabIndex={scrollState.backward || scrollState.forward ? 0 : undefined}
        aria-label={ariaLabel}
      >
        <div
          ref={contentRef}
          className="forecast-scroll-content"
          style={{ width: `${contentWidthPercent}%` }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
