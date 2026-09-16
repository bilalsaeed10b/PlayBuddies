"use client";

import { usePathname } from "next/navigation";
import FriendsSidebar from "@/components/FriendsSidebar";
import InviteListener from "@/components/InviteListener";
import FriendRequestListener from "@/components/FriendRequestListener";

/**
 * Global overlays, mounted only where they make sense.
 *
 * InviteListener and FriendRequestListener always render for signed-in users
 * so an invite or friend request toast fires even on the landing page.
 * FriendsSidebar (the floating FAB + slide-out panel) is suppressed on the
 * landing and profile pages where it would feel out of place.
 */
export default function AppChrome() {
  const pathname = usePathname();

  const hideSidebar = pathname === "/" || pathname?.startsWith("/profile");

  return (
    <>
      {!hideSidebar && <FriendsSidebar />}
      <FriendRequestListener />
      <InviteListener />
    </>
  );
}
