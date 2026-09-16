"use client";

import {
  Gamepad2,
  Star,
  Target,
  Shield,
  Zap,
  Trophy,
  Crown,
  Sparkles,
  Bug,
  BugPlay,
  Coins,
} from "lucide-react";
import type { BadgeDef, BadgeIconName } from "@/lib/badges";

/**
 * Icons live here rather than in the catalog so `badges.ts` stays a plain
 * module , the admin panel and any script can import the definitions without
 * dragging in the icon set or a React runtime.
 */
const ICONS: Record<BadgeIconName, React.ComponentType<{ size?: number; className?: string }>> = {
  gamepad: Gamepad2,
  star: Star,
  target: Target,
  shield: Shield,
  zap: Zap,
  trophy: Trophy,
  crown: Crown,
  sparkles: Sparkles,
  bug: Bug,
  "bug-plus": BugPlay,
  coins: Coins,
};

export function BadgeIcon({ name, size = 28 }: { name: BadgeIconName; size?: number }) {
  const Icon = ICONS[name] ?? Star;
  return <Icon size={size} />;
}

/**
 * The badge that rides along with a name.
 *
 * Deliberately small and label-first: it appears next to a display name in
 * lists where the name is the thing being read, so it has to be recognisable
 * at a glance without becoming the loudest element in the row.
 */
export default function BadgeChip({
  badge,
  size = "sm",
  showLabel = true,
}: {
  badge: BadgeDef | null | undefined;
  size?: "xs" | "sm";
  showLabel?: boolean;
}) {
  if (!badge) return null;
  const iconSize = size === "xs" ? 10 : 12;
  return (
    <span
      title={badge.description}
      className={`inline-flex items-center gap-1 rounded-full bg-gradient-to-r ${badge.color} text-white font-bold shrink-0 ${
        size === "xs" ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-0.5 text-[10px]"
      }`}
    >
      <BadgeIcon name={badge.icon} size={iconSize} />
      {showLabel && <span className="leading-none">{badge.label}</span>}
    </span>
  );
}
