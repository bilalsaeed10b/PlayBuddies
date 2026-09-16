"use client";

import { useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { PLAYABLE_GAMES } from "@/lib/games";
import {
  EMPTY_TRELLO,
  fetchBoard,
  fetchLists,
  isConfigured,
  loadTrelloConfig,
  saveTrelloConfig,
  type TrelloConfig,
  type TrelloList,
} from "@/lib/trello";
import { Card, Pill } from "./ui";

/**
 * Where the Trello credentials live, and where each game's bugs land.
 *
 * The key and token are typed in here rather than baked into the build for
 * one reason worth stating plainly: anything prefixed `NEXT_PUBLIC_` is
 * compiled into the JavaScript every visitor downloads, so a build-time token
 * would let any player open devtools and write to the board. These go to
 * `adminConfig/trello`, which the rules open to the admin allowlist alone.
 *
 * They are still secrets in an admin's browser, which is the honest limit of
 * a site with no backend , anyone who can open this panel can read them, and
 * that set is exactly the two people who own the board.
 */
export default function TrelloPanel() {
  const [config, setConfig] = useState<TrelloConfig>(EMPTY_TRELLO);
  const [lists, setLists] = useState<TrelloList[]>([]);
  const [boardName, setBoardName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    loadTrelloConfig()
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        setLoading(false);
        if (isConfigured(c)) void connect(c, false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Could not read the saved configuration.");
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** Prove the credentials work and pull the board's lists to map against. */
  const connect = async (c: TrelloConfig, announce = true) => {
    setBusy(true);
    setError("");
    if (announce) setNotice("");
    try {
      const [board, boardLists] = await Promise.all([fetchBoard(c), fetchLists(c)]);
      setBoardName(board.name);
      setLists(boardLists);
      if (announce) setNotice(`Connected to ${board.name}.`);
    } catch (e) {
      setBoardName("");
      setLists([]);
      setError(e instanceof Error ? e.message : "Trello refused those credentials.");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await saveTrelloConfig(config);
      setNotice("Saved.");
      await connect(config, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  const setList = (gameId: string, listId: string) =>
    setConfig((c) => ({ ...c, lists: { ...c.lists, [gameId]: listId } }));

  if (loading) {
    return (
      <Card title="Trello" subtitle="Where approved reports go">
        <div className="py-8 flex justify-center">
          <Loader2 size={22} className="animate-spin text-primary" />
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Trello"
      subtitle="Approving a report opens a card on the board"
      right={
        boardName ? (
          <Pill tone="good">
            <Check size={10} /> {boardName}
          </Pill>
        ) : (
          <Pill tone="neutral">not connected</Pill>
        )
      }
    >
      <div className="space-y-4">
        <div className="grid sm:grid-cols-3 gap-2">
          <Secret
            label="API key"
            value={config.key}
            onChange={(v) => setConfig({ ...config, key: v })}
          />
          <Secret
            label="Token"
            value={config.token}
            onChange={(v) => setConfig({ ...config, token: v })}
          />
          <Secret
            label="Board id"
            value={config.boardId}
            onChange={(v) => setConfig({ ...config, boardId: v })}
            plain
          />
        </div>

        <p className="text-[11px] text-text-muted leading-relaxed">
          Get a key at{" "}
          <a
            href="https://trello.com/power-ups/admin"
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline inline-flex items-center gap-1"
          >
            trello.com/power-ups/admin <ExternalLink size={9} />
          </a>
          , then generate a token from that same page. The board id is the code in your board URL ,
          in <span className="font-mono">trello.com/b/ow8F6781/playbuddies</span> it is{" "}
          <span className="font-mono text-text-secondary">ow8F6781</span>.
        </p>

        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={busy}
            className="flex-1 rounded-xl bg-primary py-2 text-xs font-black text-white disabled:opacity-40"
          >
            {busy ? "Working…" : "Save & connect"}
          </button>
          <button
            onClick={() => connect(config)}
            disabled={busy || !isConfigured(config)}
            title="Re-check the credentials and reload the board's lists"
            className="rounded-xl border border-white/10 px-3 py-2 text-xs font-bold text-text-secondary hover:border-white/25 disabled:opacity-40 transition-colors"
          >
            <RefreshCw size={13} />
          </button>
        </div>

        {error && <p className="text-xs text-red-400 break-words">{error}</p>}
        {notice && <p className="text-xs text-emerald-400">{notice}</p>}

        {lists.length > 0 && (
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-text-muted mb-2">
              Which list each game files into
            </h4>
            <div className="space-y-1.5">
              <ListRow
                label="Anything unmapped"
                value={config.lists[""] ?? ""}
                lists={lists}
                onChange={(v) => setList("", v)}
              />
              <ListRow
                label="Platform / not a game"
                value={config.lists.platform ?? ""}
                lists={lists}
                onChange={(v) => setList("platform", v)}
              />
              {PLAYABLE_GAMES.map((g) => (
                <ListRow
                  key={g.id}
                  label={g.name}
                  value={config.lists[g.id] ?? ""}
                  lists={lists}
                  onChange={(v) => setList(g.id, v)}
                />
              ))}
            </div>
            <p className="text-[11px] text-text-muted mt-2">
              Remember to save after changing these.
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}

function ListRow({
  label,
  value,
  lists,
  onChange,
}: {
  label: string;
  value: string;
  lists: TrelloList[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
      <span className="text-xs text-text-secondary flex-1 truncate">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white outline-none max-w-[10rem]"
      >
        <option value="">— none —</option>
        {lists.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * A credential field.
 *
 * Masked by default rather than as security theatre: this panel gets opened
 * on a shared screen often enough, and a token sitting in plain text in a
 * screenshot of the admin page is exactly how one leaks.
 */
function Secret({
  label,
  value,
  onChange,
  plain,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  plain?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div>
      <label className="text-[10px] font-bold uppercase tracking-wider text-text-muted flex items-center justify-between">
        {label}
        {!plain && value && (
          <button
            onClick={() => setShown((v) => !v)}
            className="normal-case tracking-normal text-[10px] text-primary"
          >
            {shown ? "hide" : "show"}
          </button>
        )}
      </label>
      <input
        type={plain || shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        spellCheck={false}
        autoComplete="off"
        className="mt-1 w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white font-mono outline-none focus:border-primary/50"
      />
    </div>
  );
}
