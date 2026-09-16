"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bug,
  Check,
  Clock,
  ExternalLink,
  ImageOff,
  Monitor,
  Search,
  Signal,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { getGame, PLAYABLE_GAMES } from "@/lib/games";
import { createCard, isConfigured, listFor, loadTrelloConfig } from "@/lib/trello";
import {
  BUG_STATUSES,
  CLOSED_STATUSES,
  NOTES_MAX,
  editReport,
  setReportStatus,
  setTrelloCard,
  BUG_CATEGORIES,
  BUG_SEVERITIES,
  TITLE_MAX,
  DESCRIPTION_MAX,
  type BugCategory,
  type BugEdit,
  type BugReport,
  type BugSeverity,
  type BugStatus,
} from "@/lib/bugs";
import { timeAgo } from "@/lib/adminMetrics";
import { TESTER_THRESHOLD } from "@/lib/badges";
import { Avatar, Card, Empty, Pill } from "./ui";

const SEVERITY_TONE: Record<BugSeverity, "neutral" | "warn" | "bad"> = {
  low: "neutral",
  medium: "warn",
  high: "bad",
  critical: "bad",
};

const STATUS_TONE: Record<BugStatus, "neutral" | "good" | "warn" | "bad" | "info"> = {
  new: "bad",
  triaged: "warn",
  in_progress: "info",
  fixed: "info",
  approved: "good",
  rejected: "neutral",
  duplicate: "neutral",
};

const STATUS_LABEL: Record<BugStatus, string> = {
  new: "New",
  triaged: "Triaged",
  in_progress: "In progress",
  fixed: "Fixed",
  approved: "Approved",
  rejected: "Rejected",
  duplicate: "Duplicate",
};

/**
 * The bug queue, and the only place a report's status can change.
 *
 * Approving is the consequential action here: it is what counts toward a
 * reporter's tester badge, so it sits behind its own button rather than inside
 * a status dropdown where it could be picked by accident.
 */
export default function BugQueuePanel({
  reports,
  admin,
  onChanged,
}: {
  reports: BugReport[];
  admin: { uid: string; email: string };
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<"open" | BugStatus | "all">("open");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<BugReport | null>(null);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return reports.filter((r) => {
      if (filter === "open" && CLOSED_STATUSES.includes(r.status)) return false;
      if (filter !== "open" && filter !== "all" && r.status !== filter) return false;
      if (!needle) return true;
      return (
        r.title.toLowerCase().includes(needle) ||
        r.description.toLowerCase().includes(needle) ||
        r.reporterName.toLowerCase().includes(needle) ||
        r.gameId.toLowerCase().includes(needle)
      );
    });
  }, [reports, filter, search]);

  // The detail pane renders from the live list, not from the click, so a
  // status change made in it is reflected the moment the snapshot lands.
  const open = selected ? reports.find((r) => r.id === selected.id) ?? null : null;

  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-6 items-start">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search reports"
              className="w-full bg-white/5 border border-white/10 rounded-xl pl-9 pr-3 py-2 text-sm text-white outline-none focus:border-primary/50"
            />
          </div>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none"
          >
            <option value="open">Open</option>
            <option value="all">All</option>
            {BUG_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>

        {shown.length === 0 ? (
          <Card>
            <Empty icon={<Bug size={36} />} text="Nothing in this filter." />
          </Card>
        ) : (
          <div className="space-y-2">
            {shown.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelected(r)}
                className={`w-full text-left glass rounded-2xl border p-4 transition-colors ${
                  open?.id === r.id
                    ? "border-primary/50 bg-white/5"
                    : "border-white/10 hover:border-white/25"
                }`}
              >
                <div className="flex items-start gap-3">
                  <Avatar src={r.reporterPhoto} uid={r.uid} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill>
                      <Pill tone={SEVERITY_TONE[r.severity]}>{r.severity}</Pill>
                      {r.gameId && <Pill tone="info">{getGame(r.gameId)?.name ?? r.gameId}</Pill>}
                      {!r.screenshotURL && (
                        <span title="No screenshot attached">
                          <ImageOff size={12} className="text-text-muted" />
                        </span>
                      )}
                    </div>
                    <p className="font-bold text-white text-sm truncate">{r.title}</p>
                    <p className="text-[11px] text-text-muted truncate">
                      {r.reporterName} · {timeAgo(r.createdAt)}
                    </p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="lg:sticky lg:top-6">
        {open ? (
          <ReportDetail
            report={open}
            admin={admin}
            onClose={() => setSelected(null)}
            onChanged={onChanged}
          />
        ) : (
          <Card>
            <Empty icon={<Bug size={36} />} text="Pick a report to see the details." />
          </Card>
        )}
      </div>
    </div>
  );
}

function ReportDetail({
  report,
  admin,
  onClose,
  onChanged,
}: {
  report: BugReport;
  admin: { uid: string; email: string };
  onClose: () => void;
  onChanged: () => void;
}) {
  const [notes, setNotes] = useState(report.adminNotes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  /**
   * The admin's cleaned-up version of the report.
   *
   * Held as draft state rather than written on every keystroke: this is the
   * text that becomes a Trello card, and half-typed titles have no business
   * on the board or in the queue. Seeded from the report and reset whenever a
   * different one is opened.
   */
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BugEdit>({
    title: report.title,
    description: report.description,
    gameId: report.gameId,
    severity: report.severity,
    category: report.category,
  });

  useEffect(() => {
    setNotes(report.adminNotes);
    setEditing(false);
    setError("");
    setNotice("");
    setDraft({
      title: report.title,
      description: report.description,
      gameId: report.gameId,
      severity: report.severity,
      category: report.category,
    });
  }, [report.id, report.adminNotes, report.title, report.description, report.gameId, report.severity, report.category]);

  const saveEdit = async () => {
    if (draft.title.trim().length < 4) {
      setError("A title that short will not mean anything on the board.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await editReport(report.id, draft);
      setEditing(false);
      setNotice("Report updated.");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save those edits.");
    } finally {
      setBusy(false);
    }
  };

  const apply = async (status: BugStatus) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await setReportStatus(report, status, admin, notes);

      // Trello is deliberately after the status change and reported
      // separately. A card that failed to file is a nuisance an admin can
      // retry; an approval rolled back because of it would un-credit a
      // reporter who has already been told their report was approved.
      if (status === "approved" && !report.trelloUrl) {
        try {
          const config = await loadTrelloConfig();
          if (isConfigured(config)) {
            const listId = listFor(config, report.gameId);
            if (!listId) {
              setNotice(
                `Approved. No Trello list is mapped to ${report.gameId || "this game"} , set one in System.`,
              );
            } else {
              const card = await createCard(config, listId, { ...report, ...draft });
              await setTrelloCard(report.id, card.shortUrl || card.url);
              setNotice(`Approved and filed to Trello.`);
            }
          } else {
            setNotice("Approved. Trello is not connected yet , add credentials in System.");
          }
        } catch (e) {
          console.error("Trello card failed", e);
          setNotice(
            `Approved, but Trello refused the card: ${e instanceof Error ? e.message : "unknown error"}`,
          );
        }
      }

      onChanged();
    } catch (e) {
      console.error("Status change failed", e);
      setError(e instanceof Error ? e.message : "Could not update the report.");
    } finally {
      setBusy(false);
    }
  };

  const c = report.context ?? {};

  return (
    <Card
      title={report.title}
      subtitle={`${report.reporterName} · ${report.reporterEmail}`}
      right={
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setEditing((v) => !v)}
            aria-label={editing ? "Stop editing" : "Edit this report"}
            title={editing ? "Stop editing" : "Edit before it goes to Trello"}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
              editing ? "bg-primary text-white" : "hover:bg-white/10 text-text-muted"
            }`}
          >
            <Pencil size={15} />
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-text-muted"
          >
            <X size={16} />
          </button>
        </div>
      }
      className="max-h-[calc(100vh-7rem)] overflow-y-auto"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Pill tone={STATUS_TONE[report.status]}>{STATUS_LABEL[report.status]}</Pill>
          <Pill tone={SEVERITY_TONE[report.severity]}>{report.severity}</Pill>
          <Pill>{report.category}</Pill>
          {report.gameId && <Pill tone="info">{getGame(report.gameId)?.name ?? report.gameId}</Pill>}
          {report.roomId && <Pill>room {report.roomId}</Pill>}
          {report.countedForBadge && <Pill tone="good">counted</Pill>}
          {report.trelloUrl && (
            <a href={report.trelloUrl} target="_blank" rel="noreferrer">
              <Pill tone="info">on Trello</Pill>
            </a>
          )}
        </div>

        {editing ? (
          /* The reporter can never edit their own report , this is the admin
             pass that turns "ship dissapears??" into something a developer can
             pick up off the board in three months. Saved explicitly, because
             these exact words are what becomes the card. */
          <div className="space-y-3 rounded-2xl border border-primary/30 bg-primary/5 p-3">
            <EditField label="Title">
              <input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value.slice(0, TITLE_MAX) })}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-primary/50"
              />
            </EditField>

            <EditField label="Description">
              <textarea
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value.slice(0, DESCRIPTION_MAX) })
                }
                rows={5}
                placeholder="Steps to reproduce, what happened, what should have happened."
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none resize-none focus:border-primary/50"
              />
            </EditField>

            <div className="grid grid-cols-3 gap-2">
              <EditField label="Game">
                <select
                  value={draft.gameId}
                  onChange={(e) => setDraft({ ...draft, gameId: e.target.value })}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-2 py-2 text-xs text-white outline-none"
                >
                  <option value="platform">Platform</option>
                  {PLAYABLE_GAMES.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </EditField>
              <EditField label="Area">
                <select
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value as BugCategory })}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-2 py-2 text-xs text-white outline-none capitalize"
                >
                  {BUG_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </EditField>
              <EditField label="Severity">
                <select
                  value={draft.severity}
                  onChange={(e) => setDraft({ ...draft, severity: e.target.value as BugSeverity })}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-2 py-2 text-xs text-white outline-none capitalize"
                >
                  {BUG_SEVERITIES.map((sev) => (
                    <option key={sev} value={sev}>
                      {sev}
                    </option>
                  ))}
                </select>
              </EditField>
            </div>

            <button
              disabled={busy}
              onClick={saveEdit}
              className="w-full rounded-xl bg-primary py-2 text-xs font-black text-white disabled:opacity-40"
            >
              Save edits
            </button>
          </div>
        ) : (
          report.description && (
            <p className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">
              {report.description}
            </p>
          )
        )}

        {report.screenshotURL ? (
          <a
            href={report.screenshotURL}
            target="_blank"
            rel="noreferrer"
            className="block rounded-xl overflow-hidden border border-white/10 group relative"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={report.screenshotURL}
              alt="Bug screenshot"
              className="w-full max-h-64 object-contain bg-black/40"
            />
            <span className="absolute bottom-2 right-2 px-2 py-1 rounded-lg bg-black/70 text-[10px] text-white flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <ExternalLink size={10} /> Full size
            </span>
          </a>
        ) : (
          <p className="text-xs text-text-muted flex items-center gap-2">
            <ImageOff size={13} /> No screenshot attached.
          </p>
        )}

        <details className="rounded-xl bg-white/5 border border-white/10 overflow-hidden">
          <summary className="px-3 py-2 text-xs font-bold text-text-secondary cursor-pointer select-none flex items-center gap-2">
            <Monitor size={13} /> Technical context
          </summary>
          <dl className="px-3 pb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
            <Row k="Page" v={c.url} />
            <Row k="Build" v={c.build} />
            <Row k="Viewport" v={`${c.viewport ?? "?"} @${c.devicePixelRatio ?? "?"}x`} />
            <Row k="Screen" v={c.screen} />
            <Row k="Platform" v={c.platform} />
            <Row k="Browser" v={c.userAgent} />
            <Row
              k="Network"
              v={
                c.connection
                  ? `${c.connection}${c.downlinkMbps ? ` · ${c.downlinkMbps} Mbps` : ""}${
                      c.rttMs ? ` · ${c.rttMs}ms rtt` : ""
                    }${c.saveData ? " · data saver" : ""}`
                  : undefined
              }
            />
            <Row k="Device" v={`${c.cores ?? "?"} cores · ${c.memoryGb ?? "?"} GB`} />
            <Row k="Timezone" v={c.timezone} />
            <Row k="Online" v={c.online === false ? "was offline" : "yes"} />
          </dl>
        </details>

        <div>
          <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
            Admin notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value.slice(0, NOTES_MAX))}
            rows={3}
            placeholder="What was wrong, what fixed it."
            className="mt-1.5 w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none resize-none focus:border-primary/50"
          />
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {notice && <p className="text-xs text-emerald-400">{notice}</p>}

        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            {(["triaged", "in_progress", "fixed"] as BugStatus[]).map((s) => (
              <button
                key={s}
                disabled={busy}
                onClick={() => apply(s)}
                className="py-2 rounded-xl border border-white/10 hover:bg-white/10 text-[11px] font-bold text-text-secondary disabled:opacity-40 transition-colors"
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>

          <button
            disabled={busy}
            onClick={() => apply("approved")}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-gradient-to-r from-lime-400 to-emerald-500 text-black font-black text-sm disabled:opacity-40"
          >
            <Check size={16} />
            {report.countedForBadge ? "Approved" : "Approve — credits & files to Trello"}
          </button>
          {!report.countedForBadge && (
            <p className="text-[10px] text-text-muted text-center leading-relaxed">
              Credits their Tester badge ({TESTER_THRESHOLD} approved needed) and opens a card on
              the board. Edit the wording first if it needs it.
            </p>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              disabled={busy}
              onClick={() => apply("rejected")}
              className="flex items-center justify-center gap-1.5 py-2 rounded-xl border border-red-500/30 hover:bg-red-500/10 text-[11px] font-bold text-red-300 disabled:opacity-40 transition-colors"
            >
              <Trash2 size={13} /> Reject
            </button>
            <button
              disabled={busy}
              onClick={() => apply("duplicate")}
              className="flex items-center justify-center gap-1.5 py-2 rounded-xl border border-white/10 hover:bg-white/10 text-[11px] font-bold text-text-muted disabled:opacity-40 transition-colors"
            >
              <Clock size={13} /> Duplicate
            </button>
          </div>
        </div>

        <p className="text-[10px] text-text-muted flex items-center gap-1.5">
          <Signal size={11} />
          Filed {timeAgo(report.createdAt)}
          {report.resolvedBy && ` · last touched by ${report.resolvedBy}`}
        </p>
      </div>
    </Card>
  );
}

function EditField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v?: string | number | null }) {
  if (v === undefined || v === null || v === "") return null;
  return (
    <>
      <dt className="text-text-muted whitespace-nowrap">{k}</dt>
      <dd className="text-text-secondary break-all">{String(v)}</dd>
    </>
  );
}
