"use client";

import { usePathname } from "next/navigation";
import FriendsSidebar from "@/components/FriendsSidebar";
import InviteListener from "@/components/InviteListener";

/**
 * Global overlays, mounted only where they make sense.
 *
 * These used to render on every route including the landing page, so every
 * signed-in visitor held open Firestore listeners before they had even chosen
 * to do anything.
 */
export default function AppChrome() {
  const pathname = usePathname();

  const isLanding = pathname === "/";
  if (isLanding) return null;

  // The lobby renders its own invite UI and friends picker inline.
  const isLobby = pathname?.startsWith("/lobby");

  return (
    <>
      {!isLobby && <FriendsSidebar />}
      <InviteListener />
    </>
  );
}
