"use client";

import { usePathname } from "next/navigation";
import FriendsSidebar from "@/components/FriendsSidebar";
import InviteListener from "@/components/InviteListener";
import FriendRequestListener from "@/components/FriendRequestListener";
import BugReportButton from "@/components/BugReportButton";

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
  // The admin panel is where bugs get read, not filed, and the landing page is
  // reachable signed out. Everywhere else keeps the report button, because a
  // report is worth most when filed from the screen the bug happened on.
  const hideBugButton = pathname === "/" || pathname?.startsWith("/admin");

  return (
    <>
      {!hideSidebar && <FriendsSidebar />}
      {!hideBugButton && <BugReportButton />}
      <FriendRequestListener />
      <InviteListener />
    </>
  );
}
