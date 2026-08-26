"use client";

import { usePathname } from "next/navigation";
import FriendsSidebar from "@/components/FriendsSidebar";
import InviteListener from "@/components/InviteListener";
import FriendRequestListener from "@/components/FriendRequestListener";

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

  // The lobby has its own invite UI, but a friend request can land at any
  // time — including mid-lobby — so the friends panel (and its accept/deny
  // controls) has to be reachable there too, not just from the dashboard.
  return (
    <>
      <FriendsSidebar />
      <FriendRequestListener />
      <InviteListener />
    </>
  );
}
