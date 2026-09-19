import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { BugReport } from "@/lib/bugs";

/**
 * Filing an approved bug as a Trello card.
 *
 * The credentials live in Firestore at `adminConfig/trello`, which the rules
 * open to the admin allowlist and nobody else. That is the whole reason they
 * are not an environment variable: `NEXT_PUBLIC_*` is compiled into the
 * JavaScript every visitor downloads, so a build-time token would let anyone
 * who opened devtools write to the board. This way the token is fetched at
 * runtime by a signed-in admin, and changing it is an edit in the panel
 * rather than a redeploy.
 *
 * Trello's REST API sends permissive CORS headers, so the browser can call it
 * directly and no server is needed anywhere in this path.
 */

const API = "https://api.trello.com/1";

export interface TrelloConfig {
  key: string;
  token: string;
  boardId: string;
  /** gameId -> Trello list id. The empty-string key is the fallback list. */
  lists: Record<string, string>;
}

export const EMPTY_TRELLO: TrelloConfig = { key: "", token: "", boardId: "", lists: {} };

export function isConfigured(config: TrelloConfig | null): config is TrelloConfig {
  return Boolean(config?.key && config?.token && config?.boardId);
}

export async function loadTrelloConfig(): Promise<TrelloConfig> {
  const snap = await getDoc(doc(db, "adminConfig", "trello"));
  const data = snap.data() as Partial<TrelloConfig> | undefined;
  if (!data) return EMPTY_TRELLO;
  return {
    key: data.key ?? "",
    token: data.token ?? "",
    boardId: data.boardId ?? "",
    lists: data.lists ?? {},
  };
}

export async function saveTrelloConfig(config: TrelloConfig): Promise<void> {
  await setDoc(doc(db, "adminConfig", "trello"), {
    key: config.key.trim(),
    token: config.token.trim(),
    boardId: config.boardId.trim(),
    lists: config.lists,
  });
}

function auth(config: TrelloConfig): string {
  return `key=${encodeURIComponent(config.key)}&token=${encodeURIComponent(config.token)}`;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    // Trello answers a bad key or a revoked token with a plain-text body, not
    // JSON, so the body is the useful half of the error and the status alone
    // is not: 401 "invalid token" and 401 "unauthorized permission requested"
    // need entirely different fixes.
    const detail = await res.text().catch(() => "");
    throw new Error(`Trello ${res.status}: ${detail.slice(0, 200) || res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface TrelloList {
  id: string;
  name: string;
}

export interface TrelloBoard {
  id: string;
  name: string;
  url: string;
}

/** The board's own name, which doubles as "these credentials work". */
export function fetchBoard(config: TrelloConfig): Promise<TrelloBoard> {
  return call<TrelloBoard>(`${API}/boards/${encodeURIComponent(config.boardId)}?${auth(config)}`);
}

export function fetchLists(config: TrelloConfig): Promise<TrelloList[]> {
  return call<TrelloList[]>(
    `${API}/boards/${encodeURIComponent(config.boardId)}/lists?${auth(config)}`,
  );
}

export interface TrelloCard {
  id: string;
  url: string;
  shortUrl: string;
}

/**
 * The card body.
 *
 * Everything an admin would otherwise have to copy across by hand, in the
 * order it is useful when the card is picked up later: what broke, then who
 * saw it, then the machine it broke on. The context block is last because it
 * is long and only matters once someone is actually reproducing.
 */
export function cardDescription(report: BugReport): string {
  const c = report.context ?? {};
  const lines = [
    report.description || "_No description given._",
    "",
    "---",
    `**Reporter:** ${report.reporterName}${report.reporterEmail ? ` (${report.reporterEmail})` : ""}`,
    `**Severity:** ${report.severity} · **Area:** ${report.category}`,
    report.roomId ? `**Room:** ${report.roomId}` : "",
    report.screenshotURL ? `**Screenshot:** ${report.screenshotURL}` : "_No screenshot attached._",
    "",
    "<details><summary>Capture context</summary>",
    "",
    `- Page: ${c.url ?? "?"}`,
    `- Build: ${c.build ?? "?"}`,
    `- Viewport: ${c.viewport ?? "?"} (dpr ${c.devicePixelRatio ?? "?"})`,
    `- Device: ${c.platform ?? "?"} · ${c.cores ?? "?"} cores · ${c.memoryGb ?? "?"} GB`,
    `- Link: ${c.connection ?? "?"}${c.rttMs != null ? ` · ${c.rttMs}ms rtt` : ""}`,
    `- Agent: ${c.userAgent ?? "?"}`,
    "",
    "</details>",
    "",
    `_Filed from the PlayWithBuddies admin panel · report ${report.id}_`,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/**
 * Create the card.
 *
 * The screenshot goes on as an attachment *and* stays as a link in the body:
 * the attachment gives the card a thumbnail on the board, and the link
 * survives the attachment failing, which it can , the URL is a signed
 * Firebase Storage one and Trello has to fetch it server-side.
 */
export async function createCard(
  config: TrelloConfig,
  listId: string,
  report: BugReport,
): Promise<TrelloCard> {
  const params = new URLSearchParams({
    idList: listId,
    name: report.title,
    desc: cardDescription(report),
    pos: "top",
    key: config.key,
    token: config.token,
  });
  const card = await call<TrelloCard>(`${API}/cards?${params.toString()}`, { method: "POST" });

  if (report.screenshotURL) {
    try {
      const attach = new URLSearchParams({
        url: report.screenshotURL,
        name: "screenshot.webp",
        key: config.key,
        token: config.token,
      });
      await fetch(`${API}/cards/${card.id}/attachments?${attach.toString()}`, { method: "POST" });
    } catch {
      // The card exists and carries the screenshot URL in its description.
      // Failing the whole approval over a thumbnail would be the wrong call.
    }
  }

  return card;
}

/** Which list a report belongs in, falling back to the configured catch-all. */
export function listFor(config: TrelloConfig, gameId: string): string {
  return config.lists[gameId] || config.lists[""] || "";
}
