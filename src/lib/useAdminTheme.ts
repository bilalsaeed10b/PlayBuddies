import { useCallback, useSyncExternalStore } from "react";

export type AdminTheme = "dark" | "light";

const STORAGE_KEY = "pb_admin_theme";
const listeners = new Set<() => void>();

function getSnapshot(): AdminTheme {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

// The static export prerenders this page in Node, where there is no
// localStorage and no real preference to read — dark is what every other
// screen in the app already looks like, so it's the only safe guess.
function getServerSnapshot(): AdminTheme {
  return "dark";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Light/dark for the admin panel only.
 *
 * This is deliberately not a site-wide theme system. Every other screen in
 * PlayBuddies is written with hardcoded dark colors, not theme tokens, so
 * "add light mode" for the whole app would mean re-touching every page. The
 * admin panel was built today on a small, contained set of components, which
 * is what makes scoping the toggle to just `/admin` cheap and safe rather
 * than a half-finished coat of paint over the rest of the site.
 *
 * Built on useSyncExternalStore rather than useState+useEffect: the stored
 * preference lives outside React (localStorage), and this is the hook meant
 * for reading external state like that without a render that briefly shows
 * the wrong theme before an effect corrects it after mount.
 */
export function useAdminTheme(): [AdminTheme, () => void] {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback(() => {
    const next: AdminTheme = getSnapshot() === "dark" ? "light" : "dark";
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Per-browser convenience only; a failed write just means the toggle
      // reverts to dark on the next visit, not a broken panel.
    }
    listeners.forEach((l) => l());
  }, []);

  return [theme, toggle];
}
