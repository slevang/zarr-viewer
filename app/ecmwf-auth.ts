const CDS_KEY_STORAGE_KEY = "zarr-viewer:ecmwf-cds-api-key";

export type EcmwfAuthSnapshot = {
  phase: "disconnected" | "connected" | "error";
  message: string;
};

export class EcmwfAuthorizationRequiredError extends Error {
  constructor(message = "ECMWF CDS API key required") {
    super(message);
    this.name = "EcmwfAuthorizationRequiredError";
  }
}

let cdsApiKey = "";
let snapshot: EcmwfAuthSnapshot = {
  phase: "disconnected",
  message: "ECMWF CDS API key required",
};
const listeners = new Set<(next: EcmwfAuthSnapshot) => void>();

function storedKey() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(CDS_KEY_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function publish(next: EcmwfAuthSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener(next);
}

cdsApiKey = storedKey();
if (cdsApiKey) {
  snapshot = {
    phase: "connected",
    message: "CDS API key saved locally",
  };
}

export function ecmwfAuthSnapshot() {
  return snapshot;
}

export function subscribeEcmwfAuth(
  listener: (next: EcmwfAuthSnapshot) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function hasCdsApiKey() {
  return Boolean(cdsApiKey);
}

export function setCdsApiKey(value: string) {
  const next = value.trim();
  if (!next) {
    throw new EcmwfAuthorizationRequiredError();
  }
  cdsApiKey = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CDS_KEY_STORAGE_KEY, cdsApiKey);
    } catch {
      // The in-memory key remains usable if persistent storage is unavailable.
    }
  }
  publish({
    phase: "connected",
    message: "CDS API key saved locally",
  });
}

export function disconnectEcmwf() {
  cdsApiKey = "";
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(CDS_KEY_STORAGE_KEY);
    } catch {
      // The in-memory key has still been cleared.
    }
  }
  publish({
    phase: "disconnected",
    message: "ECMWF CDS API key required",
  });
}

export async function ecmwfAuthorizedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  if (!cdsApiKey) throw new EcmwfAuthorizationRequiredError();
  const request = new Request(input, init);
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${cdsApiKey}`);
  const response = await fetch(new Request(request, { headers }));
  if (response.status === 401) {
    disconnectEcmwf();
    throw new EcmwfAuthorizationRequiredError(
      "The CDS API key was rejected; enter it again",
    );
  }
  if (response.status === 403) {
    publish({
      phase: "error",
      message: "ECMWF denied access; confirm the ERA5 licence is accepted in CDS",
    });
  }
  return response;
}
