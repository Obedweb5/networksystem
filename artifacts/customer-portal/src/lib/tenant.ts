// This is a multi-tenant portal with no other way (yet) to know which ISP's
// customer is visiting besides the `?tenantId=` query param the ISP's link
// or QR code carries. That param only ever arrives on the *first* page
// load, though — wouter's navigate("/login") etc. is a client-side route
// change and does not preserve the current query string, so a bare
// navigate() call drops tenantId entirely and every subsequent request
// silently sends tenantId: "" (see login.tsx / packages.tsx history for the
// bug this caused: 500s from /portal/auth/otp/request because "" isn't a
// valid tenant_id).
//
// Fix: cache the first tenantId we see and fall back to it whenever the URL
// doesn't have one. Session-scoped (not localStorage) since a shared/kiosk
// device shouldn't remember a stale tenant across browser sessions.
const STORAGE_KEY = "pulsenet_portal_tenant_id";

export function getTenantId(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("tenantId");
  if (fromUrl) {
    try {
      sessionStorage.setItem(STORAGE_KEY, fromUrl);
    } catch {
      // sessionStorage can throw in locked-down/private browsing contexts —
      // fine, we still have fromUrl for this page load.
    }
    return fromUrl;
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Appends the current tenantId to an in-app path, so links/navigate() calls don't drop it. */
export function withTenant(path: string): string {
  const tenantId = getTenantId();
  if (!tenantId) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}tenantId=${encodeURIComponent(tenantId)}`;
}
