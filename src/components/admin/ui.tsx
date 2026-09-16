"use client";

/** Shared shapes for the admin panels, so six files agree on one look. */

export function Card({
  title,
  subtitle,
  right,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`glass rounded-2xl border border-white/10 p-5 ${className}`}>
      {(title || right) && (
        <header className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            {title && <h2 className="font-black text-white leading-tight">{title}</h2>}
            {subtitle && <p className="text-[11px] text-text-muted mt-0.5">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
  icon,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad";
  icon?: React.ReactNode;
  onClick?: () => void;
}) {
  const toneClass = {
    default: "text-white",
    good: "text-emerald-400",
    warn: "text-amber-400",
    bad: "text-red-400",
  }[tone];

  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={`glass rounded-2xl border border-white/10 p-4 text-left w-full ${
        onClick ? "hover:border-white/25 transition-colors" : ""
      }`}
    >
      <div className="flex items-center gap-2 mb-2 text-text-muted">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
      </div>
      <p className={`text-2xl font-black tabular-nums ${toneClass}`}>{value}</p>
      {hint && <p className="text-[11px] text-text-muted mt-1">{hint}</p>}
    </Tag>
  );
}

/**
 * A quota bar.
 *
 * `estimated` is not decoration. Nothing in a browser can read the project's
 * real daily read count, so a bar without that mark would be inventing
 * authority it does not have.
 */
export function Meter({
  label,
  used,
  limit,
  format,
  estimated = false,
}: {
  label: string;
  used: number;
  limit: number;
  format?: (n: number) => string;
  estimated?: boolean;
}) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const show = format ?? ((n: number) => n.toLocaleString());
  const tone =
    ratio > 0.9 ? "bg-red-500" : ratio > 0.7 ? "bg-amber-400" : "bg-emerald-400";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="text-xs font-bold text-text-secondary flex items-center gap-1.5">
          {label}
          {estimated && (
            <span className="px-1.5 py-0.5 rounded bg-white/10 text-[9px] uppercase tracking-wide text-text-muted">
              est
            </span>
          )}
        </span>
        <span className="text-[11px] text-text-muted tabular-nums">
          {show(used)} / {show(limit)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

export function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="py-14 flex flex-col items-center gap-3 text-text-muted">
      <div className="opacity-40">{icon}</div>
      <p className="text-sm">{text}</p>
    </div>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
}) {
  const tones = {
    neutral: "bg-white/10 text-text-secondary",
    good: "bg-emerald-500/20 text-emerald-300",
    warn: "bg-amber-500/20 text-amber-300",
    bad: "bg-red-500/20 text-red-300",
    info: "bg-sky-500/20 text-sky-300",
  };
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** Avatar with the dicebear fallback the rest of the app already uses. */
export function Avatar({ src, uid, size = 32 }: { src?: string; uid: string; size?: number }) {
  const fallback = `https://api.dicebear.com/7.x/avataaars/svg?seed=${uid}`;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src || fallback}
      alt=""
      width={size}
      height={size}
      onError={(e) => {
        e.currentTarget.onerror = null;
        e.currentTarget.src = fallback;
      }}
      style={{ width: size, height: size }}
      className="rounded-full border border-white/15 shrink-0 object-cover"
    />
  );
}
