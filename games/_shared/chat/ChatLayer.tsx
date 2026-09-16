/**
 * The whole chat UI shell , open button, `T` shortcut, composer , wired
 * together the same way in every game. Only `onSend` differs between them:
 * what actually carries the words to the other players is each game's own
 * transport (a turn doc for the turn-based games, the mesh for the two
 * real-time ones), which is why this component knows nothing about it.
 */
import { useCallback, useState } from 'react';
import { ChatButton } from './ChatButton';
import { ChatComposer } from './ChatComposer';
import { useChatHotkey } from './useChatHotkey';

export function ChatLayer({
  onSend,
  hotkeyEnabled = true,
  buttonClassName = 'absolute left-2 top-2 z-30',
}: {
  onSend: (text: string) => void;
  /** False for a game whose own keyboard input `T` would collide with (last-gasp guesses the letter T). The button still works. */
  hotkeyEnabled?: boolean;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useChatHotkey(hotkeyEnabled, useCallback(() => setOpen(true), []));

  return (
    <>
      {!open && <ChatButton onClick={() => setOpen(true)} className={buttonClassName} />}
      <ChatComposer open={open} onClose={close} onSend={onSend} />
    </>
  );
}
