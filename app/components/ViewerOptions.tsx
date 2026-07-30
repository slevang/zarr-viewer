import { useEffect, useRef, useState } from "react";
import {
  GlobeIcon,
  MapIcon,
  ResetViewIcon,
  ShareIcon,
} from "./ToolbarIcons";

type ViewerOptionsProps = {
  className?: string;
  projection: "globe" | "mercator";
  shareStatus: "idle" | "copied" | "error";
  shareDisabled: boolean;
  onProjectionChange: (projection: "globe" | "mercator") => void;
  onResetView: () => void;
  onShare: () => void;
};

export function ViewerOptions({
  className = "",
  projection,
  shareStatus,
  shareDisabled,
  onProjectionChange,
  onResetView,
  onShare,
}: ViewerOptionsProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && !containerRef.current?.contains(event.target)
      ) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      className={`viewer-options ${className}`.trim()}
    >
      <button
        className="viewer-options-trigger"
        type="button"
        aria-label="Viewer options"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Viewer options"
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">•••</span>
      </button>
      {open ? (
        <div
          className="viewer-options-menu"
          role="dialog"
          aria-label="Viewer options"
        >
          <span className="viewer-options-label">Projection</span>
          <div
            className="viewer-options-projection"
            role="group"
            aria-label="Map projection"
          >
            <button
              className={projection === "globe" ? "active" : ""}
              type="button"
              aria-pressed={projection === "globe"}
              onClick={() => onProjectionChange("globe")}
            >
              <GlobeIcon />
              Globe
            </button>
            <button
              className={projection === "mercator" ? "active" : ""}
              type="button"
              aria-pressed={projection === "mercator"}
              onClick={() => onProjectionChange("mercator")}
            >
              <MapIcon />
              Flat
            </button>
          </div>
          <button
            className="viewer-options-action"
            type="button"
            onClick={() => {
              onResetView();
              setOpen(false);
            }}
          >
            <ResetViewIcon />
            Reset map view
          </button>
          <button
            className={`viewer-options-action ${shareStatus}`}
            type="button"
            disabled={shareDisabled}
            aria-live="polite"
            onClick={onShare}
          >
            <ShareIcon />
            {shareStatus === "copied"
              ? "Share link copied"
              : shareStatus === "error"
                ? "Could not copy link"
                : "Copy share link"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
