"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  remoteDiagnosticsEnabled,
  writeRemoteDiagnostics,
  type RemoteDiagnosticsContext,
} from "@/lib/remoteDiagnostics";

const FLUSH_MS = 5000;
const MAX_QUEUE = 400;
const WRITE_SIZE = 40;

/**
 * Buffers iframe messages away from React and serializes Firestore writes.
 * A slow diagnostic write can never delay a game message or build an
 * unbounded queue on a weak phone.
 */
export function useRemoteDiagnostics(context: RemoteDiagnosticsContext | null) {
  const contextRef = useRef(context);
  const queueRef = useRef<unknown[]>([]);
  const timerRef = useRef<number | null>(null);
  const writesRef = useRef(Promise.resolve());
  // Preserve the last live match long enough for an unmount/pagehide flush.
  useEffect(() => {
    if (context) contextRef.current = context;
  }, [context]);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const live = contextRef.current;
    if (!live || !remoteDiagnosticsEnabled() || queueRef.current.length === 0) return;
    const waiting = queueRef.current.splice(0);
    for (let start = 0; start < waiting.length; start += WRITE_SIZE) {
      const batch = waiting.slice(start, start + WRITE_SIZE);
      writesRef.current = writesRef.current
        .then(() => writeRemoteDiagnostics(live, batch))
        .then(() => undefined)
        .catch((error) => {
          // Keep gameplay independent, but make collector failures visible in
          // the parent console during diagnosis.
          console.error("Remote diagnostics write failed", error);
        });
    }
  }, []);

  const enqueue = useCallback((entries: unknown) => {
    if (!remoteDiagnosticsEnabled() || !Array.isArray(entries)) return;
    queueRef.current.push(...entries.slice(0, WRITE_SIZE));
    if (queueRef.current.length > MAX_QUEUE) {
      queueRef.current.splice(0, queueRef.current.length - MAX_QUEUE);
    }
    if (queueRef.current.length >= WRITE_SIZE) flush();
    else if (timerRef.current === null) timerRef.current = window.setTimeout(flush, FLUSH_MS);
  }, [flush]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
      flush();
    };
  }, [flush]);

  return enqueue;
}
