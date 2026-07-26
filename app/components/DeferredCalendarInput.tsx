import { useState } from "react";

type DeferredCalendarInputProps = {
  axisId: string;
  label: string;
  value: string;
  min: string;
  max: string;
  onCommit: (value: string) => void;
};

export function DeferredCalendarInput({
  axisId,
  label,
  value,
  min,
  max,
  onCommit,
}: DeferredCalendarInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const pendingValue = draft ?? value;

  const commitDraft = (next: string) => {
    if (!next || next === value) return;
    onCommit(next);
  };

  return (
    <input
      className="axis-calendar"
      aria-label={`${label} calendar`}
      data-testid={`calendar-${axisId}`}
      type="datetime-local"
      step="3600"
      value={pendingValue}
      min={min}
      max={max}
      onInput={(event) => setDraft(event.currentTarget.value)}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => commitDraft(pendingValue)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setDraft(null);
      }}
      onKeyUp={(event) => {
        if (event.key === "Enter") commitDraft(event.currentTarget.value);
      }}
    />
  );
}

