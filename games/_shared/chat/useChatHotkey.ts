/**
 * T opens the composer , the shortcut Roblox trained a generation of players
 * on. Ignored while any text field already has focus, so typing the letter T
 * anywhere else on the page never hijacks it.
 */
import { useEffect } from 'react';

export function useChatHotkey(enabled: boolean, onOpen: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyT' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      onOpen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onOpen]);
}
