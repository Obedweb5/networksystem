import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { setAuthTokenGetter, getBaseUrl } from "@/lib/api-client";

interface CustomerInfo {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  accountNumber: string | null;
  tenantId: string;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  customer: CustomerInfo | null;
  /** Epoch ms the current accessToken stops being valid. Null whenever accessToken is null. */
  expiresAt: number | null;
}

interface AuthContextValue extends AuthState {
  login: (
    accessToken: string,
    refreshToken: string,
    customer: CustomerInfo,
    expiresIn?: number
  ) => void;
  logout: () => void;
  /** Merges a partial update into the stored customer (e.g. after a profile edit) so the header greeting, avatar initials, and account menu — all of which read from this context, not from whichever page happens to hold fresh query data — stay in sync without requiring a re-login. */
  updateCustomer: (patch: Partial<CustomerInfo>) => void;
  isAuthenticated: boolean;
}

const AUTH_KEY = "pulsenet_portal_auth";
const EMPTY_STATE: AuthState = { accessToken: null, refreshToken: null, customer: null, expiresAt: null };
// Access tokens are minted with a fixed 900s TTL (see signCustomerAccessToken
// server-side) — refresh a little early so a request that's already in
// flight when the token would expire still lands with a valid one.
const REFRESH_SKEW_MS = 30_000;

function loadFromStorage(): AuthState {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return EMPTY_STATE;
    return { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<AuthState>) };
  } catch {
    return EMPTY_STATE;
  }
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(loadFromStorage);

  // The token getter below is handed to the shared API client once and then
  // called on every authenticated request, well after this component may
  // have re-rendered — so it reads from a ref (always current) rather than
  // closing over `state` (which would go stale the moment it's captured).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const logout = useCallback(() => {
    localStorage.removeItem(AUTH_KEY);
    stateRef.current = EMPTY_STATE;
    setState(EMPTY_STATE);
    setAuthTokenGetter(null);
  }, []);

  const login = useCallback(
    (accessToken: string, refreshToken: string, customer: CustomerInfo, expiresIn = 900) => {
      const next: AuthState = { accessToken, refreshToken, customer, expiresAt: Date.now() + expiresIn * 1000 };
      localStorage.setItem(AUTH_KEY, JSON.stringify(next));
      stateRef.current = next;
      setState(next);
    },
    []
  );

  // In-flight refresh call, shared so concurrent requests that all notice an
  // expiring token trigger exactly one /auth/refresh instead of a stampede.
  const refreshingRef = useRef<Promise<string | null> | null>(null);

  const refreshAccessToken = useCallback((): Promise<string | null> => {
    if (refreshingRef.current) return refreshingRef.current;

    refreshingRef.current = (async () => {
      const refreshToken = stateRef.current.refreshToken;
      if (!refreshToken) return null;
      try {
        const base = getBaseUrl() ?? "";
        const res = await fetch(`${base}/api/portal/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
        const data = (await res.json()) as { accessToken: string; expiresIn?: number };
        const next: AuthState = {
          ...stateRef.current,
          accessToken: data.accessToken,
          expiresAt: Date.now() + (data.expiresIn ?? 900) * 1000,
        };
        localStorage.setItem(AUTH_KEY, JSON.stringify(next));
        stateRef.current = next;
        setState(next);
        return data.accessToken;
      } catch {
        // Refresh token is gone, revoked, or expired — nothing left to try.
        // Clear the session so the UI reflects logged-out state instead of
        // quietly retrying a doomed request on every subsequent call.
        localStorage.removeItem(AUTH_KEY);
        stateRef.current = EMPTY_STATE;
        setState(EMPTY_STATE);
        return null;
      } finally {
        refreshingRef.current = null;
      }
    })();

    return refreshingRef.current;
  }, []);

  // Registered once — reads stateRef fresh on every call, and refreshes
  // ahead of expiry instead of waiting for a request to 401.
  useEffect(() => {
    setAuthTokenGetter(async () => {
      const current = stateRef.current;
      if (!current.accessToken) return null;
      const expiringSoon = current.expiresAt !== null && Date.now() > current.expiresAt - REFRESH_SKEW_MS;
      if (expiringSoon) return refreshAccessToken();
      return current.accessToken;
    });
    return () => setAuthTokenGetter(null);
  }, [refreshAccessToken]);

  const updateCustomer = useCallback((patch: Partial<CustomerInfo>) => {
    const current = stateRef.current;
    if (!current.customer) return;
    const next: AuthState = { ...current, customer: { ...current.customer, ...patch } };
    localStorage.setItem(AUTH_KEY, JSON.stringify(next));
    stateRef.current = next;
    setState(next);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        login,
        logout,
        updateCustomer,
        isAuthenticated: Boolean(state.accessToken && state.customer),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
