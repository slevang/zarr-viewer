type ToolbarIconProps = {
  size?: number;
};

export function ShareIcon({ size = 15 }: ToolbarIconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
    >
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="m8.3 10.9 7.4-4.7M8.3 13.1l7.4 4.7" />
    </svg>
  );
}

export function GlobeIcon({ size = 16 }: ToolbarIconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.8 12h16.4M12 3.5c2.3 2.3 3.5 5.1 3.5 8.5S14.3 18.2 12 20.5M12 3.5C9.7 5.8 8.5 8.6 8.5 12s1.2 6.2 3.5 8.5" />
    </svg>
  );
}

export function MapIcon({ size = 16 }: ToolbarIconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
    >
      <path d="m3.5 6.2 5-2.2 7 2.4 5-2.2v13.6l-5 2.2-7-2.4-5 2.2zM8.5 4v13.6M15.5 6.4V20" />
    </svg>
  );
}

export function ResetViewIcon({ size = 16 }: ToolbarIconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
    >
      <path d="M5.1 8.5A8 8 0 1 1 4 14M5.1 8.5H10M5.1 8.5V3.7" />
    </svg>
  );
}
