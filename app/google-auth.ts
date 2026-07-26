const DEFAULT_GOOGLE_OAUTH_CLIENT_ID =
  "566152755333-7csub9vg4dmuvpagik805dg7682m5qn8.apps.googleusercontent.com";
const GOOGLE_OAUTH_CLIENT_ID =
  import.meta.env?.VITE_GOOGLE_OAUTH_CLIENT_ID || DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const TOKEN_STORAGE_KEY = "zarr-viewer:google-storage-token";
const AUTH_RESULT_PREFIX = "zarr-viewer:google-auth-result:";
const AUTH_TIMEOUT_MS = 5 * 60_000;

type GoogleAuthBridgeResult = {
  type: "token";
  accessToken: string;
  expiresIn: number;
} | {
  type: "error";
  message: string;
};

export type GoogleAuthSnapshot = {
  phase: "disconnected" | "connecting" | "connected" | "error";
  message: string;
};

export class GoogleAuthorizationRequiredError extends Error {
  constructor(message = "WeatherNext credentials required") {
    super(message);
    this.name = "GoogleAuthorizationRequiredError";
  }
}

let accessToken = "";
let tokenExpiresAt = 0;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let authorizationPromise: Promise<void> | undefined;
let snapshot: GoogleAuthSnapshot = {
  phase: "disconnected",
  message: "WeatherNext credentials required",
};
const listeners = new Set<(next: GoogleAuthSnapshot) => void>();

function storedToken() {
  if (typeof window === "undefined") return undefined;
  try {
    const value = window.localStorage.getItem(TOKEN_STORAGE_KEY)
      ?? window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as {
      accessToken?: string;
      expiresAt?: number;
    };
    if (
      typeof parsed.accessToken === "string"
      && typeof parsed.expiresAt === "number"
      && parsed.expiresAt > Date.now()
    ) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, value);
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      return {
        accessToken: parsed.accessToken,
        expiresAt: parsed.expiresAt,
      };
    }
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return undefined;
}

function rememberToken() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({
      accessToken,
      expiresAt: tokenExpiresAt,
    }));
  } catch {
    // The in-memory token remains usable if persistent storage is unavailable.
  }
}

function forgetStoredToken() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing else is required when storage is unavailable.
  }
}

function scheduleTokenExpiry() {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  const remaining = Math.max(0, tokenExpiresAt - Date.now());
  expiryTimer = setTimeout(() => {
    clearToken("Google access expired; reconnect to continue");
  }, remaining);
}

function publish(next: GoogleAuthSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener(next);
}

function clearToken(message = "WeatherNext credentials required") {
  accessToken = "";
  tokenExpiresAt = 0;
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  forgetStoredToken();
  publish({ phase: "disconnected", message });
}

function acceptToken(result: Extract<GoogleAuthBridgeResult, { type: "token" }>) {
  accessToken = result.accessToken;
  tokenExpiresAt = Date.now() + Math.max(
    0,
    Number(result.expiresIn || 3600) * 1_000 - TOKEN_EXPIRY_MARGIN_MS,
  );
  rememberToken();
  scheduleTokenExpiry();
  publish({
    phase: "connected",
    message: "WeatherNext authenticated",
  });
}

const restoredToken = storedToken();
if (restoredToken) {
  accessToken = restoredToken.accessToken;
  tokenExpiresAt = restoredToken.expiresAt;
  snapshot = {
    phase: "connected",
    message: "WeatherNext authenticated",
  };
  scheduleTokenExpiry();
}

export function googleAuthSnapshot() {
  if (accessToken && Date.now() >= tokenExpiresAt) {
    clearToken("Google access expired; reconnect to continue");
  }
  return snapshot;
}

export function subscribeGoogleAuth(
  listener: (next: GoogleAuthSnapshot) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function hasGoogleAccessToken() {
  return Boolean(accessToken && Date.now() < tokenExpiresAt);
}

export async function requestGoogleAuthorization() {
  if (hasGoogleAccessToken()) return;
  if (authorizationPromise) return authorizationPromise;
  publish({ phase: "connecting", message: "Connecting to Google…" });

  authorizationPromise = new Promise<void>((resolve, reject) => {
    const channelName = `zarr-viewer-google-auth-${crypto.randomUUID()}`;
    const resultStorageKey = `${AUTH_RESULT_PREFIX}${channelName}`;
    const channel = new BroadcastChannel(channelName);
    const bridgeUrl = new URL(
      `${import.meta.env.BASE_URL}google-auth.html`,
      window.location.origin,
    );
    bridgeUrl.searchParams.set("client_id", GOOGLE_OAUTH_CLIENT_ID);
    bridgeUrl.searchParams.set("channel", channelName);
    let settled = false;

    const cleanup = () => {
      channel.close();
      window.removeEventListener("storage", onStorage);
      window.clearTimeout(timeout);
      try {
        window.localStorage.removeItem(resultStorageKey);
      } catch {
        // The BroadcastChannel path remains available without local storage.
      }
    };
    const fail = (message: string) => {
      if (settled || hasGoogleAccessToken()) return;
      settled = true;
      cleanup();
      const error = new Error(message);
      publish({ phase: "error", message });
      reject(error);
    };
    const handleResult = (result: GoogleAuthBridgeResult) => {
      if (settled) return;
      if (result.type === "error") {
        fail(result.message);
        return;
      }
      if (!result.accessToken) {
        fail("Google did not return an access token");
        return;
      }
      settled = true;
      cleanup();
      acceptToken(result);
      resolve();
    };
    const readStoredResult = () => {
      try {
        const value = window.localStorage.getItem(resultStorageKey);
        if (value) handleResult(JSON.parse(value) as GoogleAuthBridgeResult);
      } catch {
        // BroadcastChannel is the primary bridge transport.
      }
    };
    function onStorage(event: StorageEvent) {
      if (event.key === resultStorageKey) readStoredResult();
    }

    channel.addEventListener("message", (event) => {
      handleResult(event.data as GoogleAuthBridgeResult);
    });
    window.addEventListener("storage", onStorage);
    const timeout = window.setTimeout(() => {
      fail("Google authorization timed out");
    }, AUTH_TIMEOUT_MS);
    const popup = window.open(
      bridgeUrl,
      "zarr-viewer-google-auth",
      "popup=yes,width=520,height=640",
    );
    if (!popup) {
      fail("The Google authorization popup was blocked");
      return;
    }
  }).finally(() => {
    authorizationPromise = undefined;
  });
  return authorizationPromise;
}

export function disconnectGoogle() {
  clearToken();
}

export async function googleAuthorizedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  if (!hasGoogleAccessToken()) {
    throw new GoogleAuthorizationRequiredError();
  }
  const request = new Request(input, init);
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(new Request(request, { headers }));
  if (response.status === 401) {
    clearToken("Google access expired; reconnect to continue");
    throw new GoogleAuthorizationRequiredError(
      "Google access expired; reconnect to continue",
    );
  }
  return response;
}
