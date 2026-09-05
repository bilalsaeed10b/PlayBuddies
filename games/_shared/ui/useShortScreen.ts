import { useEffect, useState } from 'react';

/**
 * True when the screen is too short to spend height freely — a phone held
 * sideways, which is how these games are actually played on a phone.
 *
 * The CSS half of this is the `short:` variant each game defines in its
 * index.css, and anything that can be solved in CSS should be. This hook is
 * for the cases that cannot: a canvas whose pixel size is set in JS, or a
 * layout that has to be a different shape rather than a smaller one. Same
 * 520px threshold as the variant, deliberately — two numbers that could drift
 * apart would be a bug waiting to happen.
 *
 * Matches on `orientation` too, so a phone that reports an odd viewport height
 * mid-rotation still counts as short while it is sideways.
 */
const QUERY = '(max-height: 520px)';

export function useShortScreen(): boolean {
  const [short, setShort] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(QUERY).matches
      : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(QUERY);
    const handle = () => setShort(mql.matches);
    handle();
    mql.addEventListener('change', handle);
    return () => mql.removeEventListener('change', handle);
  }, []);

  return short;
}

export default useShortScreen;
