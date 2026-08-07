"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  query,
  where,
  limit,
  getDocs,
  getDoc,
  setDoc,
  doc,
  deleteDoc,
  serverTimestamp,
  addDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import { useFriends, type FriendProfile } from "@/hooks/useFriends";
import { useFriendsOnline } from "@/hooks/usePresence";
import { normalizeRoomCode, inviteTimestamps } from "@/lib/rooms";
import { Users, X, UserPlus, Check, MessageCircle, Search } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const FRIEND_CODE_LENGTH = 8;

export default function FriendsSidebar() {
  const user = useAuthStore((s) => s.user);
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<"friends" | "requests" | "add">("friends");

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FriendProfile[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "searching" | "empty">("idle");
  const [myCode, setMyCode] = useState<string>("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>("");

  // The listener only runs while the panel is open — it used to stay open on
  // every page for every signed-in user, including during gameplay.
  const { friends, requests } = useFriends(isOpen);
  const friendUids = useMemo(() => friends.map((f) => f.uid), [friends]);
  const onlineUids = useFriendsOnline(friendUids);

  useEffect(() => {
    if (!user || !isOpen || myCode) return;
    getDoc(doc(db, "profiles", user.uid))
      .then((snap) => {
        if (snap.exists()) setMyCode(snap.data().friendCode || "");
      })
      .catch((e) => console.error("Could not load friend code", e));
  }, [user, isOpen, myCode]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = searchQuery.trim().toUpperCase();
    if (code.length !== FRIEND_CODE_LENGTH || !user) return;

    setSearchState("searching");
    try {
      // Searches the public profile collection — which by design holds no email
      // or stats — and states a limit, because the rules reject profile queries
      // that don't bound themselves.
      const snap = await getDocs(
        query(collection(db, "profiles"), where("friendCode", "==", code), limit(5)),
      );
      const results = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            uid: d.id,
            displayName: data.displayName || "Player",
            photoURL: data.photoURL || "",
            friendCode: data.friendCode,
            connId: "",
          } as FriendProfile;
        })
        .filter((d) => d.uid !== user.uid);

      setSearchResults(results);
      setSearchState(results.length === 0 ? "empty" : "idle");
    } catch (e) {
      console.error("Search failed:", e);
      setSearchState("empty");
    }
  };

  const sendRequest = async (targetUid: string) => {
    if (!user) return;
    const connId = [user.uid, targetUid].sort().join("_");
    const ref = doc(db, "connections", connId);

    try {
      // Guard against clobbering an existing link. A plain setDoc would reset an
      // already-accepted friendship back to "pending".
      const existing = await getDoc(ref);
      if (existing.exists()) {
        const status = existing.data().status;
        setNotice(status === "accepted" ? "You're already friends." : "Request already pending.");
        setTimeout(() => setNotice(""), 2500);
        return;
      }

      await setDoc(ref, {
        participants: [user.uid, targetUid].sort(),
        status: "pending",
        senderId: user.uid,
        createdAt: serverTimestamp(),
      });
      setSentTo(targetUid);
      setTimeout(() => setSentTo(null), 2500);
    } catch (e) {
      console.error("Could not send request", e);
      setNotice("Couldn't send that request.");
      setTimeout(() => setNotice(""), 2500);
    }
  };

  const acceptRequest = async (connId: string) => {
    try {
      await setDoc(doc(db, "connections", connId), { status: "accepted" }, { merge: true });
    } catch (e) {
      console.error("Could not accept request", e);
    }
  };

  const denyRequest = async (connId: string) => {
    try {
      await deleteDoc(doc(db, "connections", connId));
    } catch (e) {
      console.error("Could not decline request", e);
    }
  };

  const inviteFriend = async (friendId: string) => {
    if (!user) return;
    // Invites are room-scoped, so they only make sense from inside a lobby.
    const room = normalizeRoomCode(new URLSearchParams(window.location.search).get("room") || "");
    if (!room) {
      setNotice("Join or create a lobby first, then invite.");
      setTimeout(() => setNotice(""), 3000);
      return;
    }

    try {
      await addDoc(collection(db, "invites"), {
        targetId: friendId,
        fromUid: user.uid,
        fromName: user.displayName || "A friend",
        roomId: room,
        ...inviteTimestamps(),
      });
      setSentTo(friendId);
      setTimeout(() => setSentTo(null), 2500);
    } catch (e) {
      console.error("Invite error:", e);
      setNotice("Couldn't send that invite.");
      setTimeout(() => setNotice(""), 2500);
    }
  };

  if (!user) return null;

  const onlineCount = onlineUids.size;

  return (
    <>
      {!isOpen && (
        <motion.button
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 p-4 rounded-full bg-primary/80 backdrop-blur-md shadow-[0_0_20px_#ff4400] text-white hover:bg-primary transition-colors flex items-center gap-2"
        >
          <Users size={24} />
          <span className="font-bold hidden sm:inline-block">Friends</span>
          {requests.length > 0 && (
            <span className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 rounded-full text-xs flex items-center justify-center font-black">
              {requests.length}
            </span>
          )}
        </motion.button>
      )}

      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsOpen(false)}
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100]"
            />

            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed top-0 right-0 bottom-0 w-full sm:w-96 glass-solid z-[101] shadow-2xl border-l border-white/10 flex flex-col"
            >
              <div className="p-6 border-b border-white/10 flex items-center justify-between">
                <h2 className="text-2xl font-black text-white flex items-center gap-3">
                  <Users className="text-primary" /> Friends
                </h2>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-2 text-white/50 hover:text-white transition-colors hover:bg-white/10 rounded-xl"
                  aria-label="Close friends panel"
                >
                  <X size={24} />
                </button>
              </div>

              <div className="flex px-4 pt-4 gap-2">
                {[
                  { id: "friends", label: `Friends (${onlineCount}/${friends.length})` },
                  { id: "requests", label: `Requests (${requests.length})` },
                  { id: "add", label: "Add Friend" },
                ].map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id as typeof tab)}
                    className={`flex-1 py-2 px-2 text-xs font-bold rounded-t-xl transition-colors border-b-2 ${
                      tab === t.id
                        ? "border-primary text-primary bg-white/5"
                        : "border-transparent text-text-muted hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {notice && (
                <p className="mx-4 mt-3 text-xs text-center text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg py-2 px-3">
                  {notice}
                </p>
              )}

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {tab === "friends" &&
                  (friends.length === 0 ? (
                    <EmptyState icon={<Users size={48} />} text="No friends yet." />
                  ) : (
                    friends.map((f) => (
                      <div
                        key={f.uid}
                        className="glass p-3 rounded-2xl border border-white/5 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="relative shrink-0">
                            <Avatar uid={f.uid} src={f.photoURL} name={f.displayName} />
                            <span
                              className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-black ${
                                onlineUids.has(f.uid) ? "bg-success" : "bg-white/30"
                              }`}
                              title={onlineUids.has(f.uid) ? "Online" : "Offline"}
                            />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-white truncate">{f.displayName}</p>
                            <p className="text-[11px] text-text-muted">
                              {onlineUids.has(f.uid) ? "Online" : "Offline"}
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => inviteFriend(f.uid)}
                          disabled={sentTo === f.uid}
                          className="bg-primary hover:bg-primary/80 text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors disabled:opacity-60 shrink-0"
                          title="Invite to your lobby"
                        >
                          <MessageCircle size={14} /> {sentTo === f.uid ? "Sent" : "Invite"}
                        </button>
                      </div>
                    ))
                  ))}

                {tab === "requests" &&
                  (requests.length === 0 ? (
                    <EmptyState icon={<UserPlus size={48} />} text="No pending requests." />
                  ) : (
                    requests.map((r) => (
                      <div
                        key={r.uid}
                        className="glass p-3 rounded-2xl border border-white/5 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <Avatar uid={r.uid} src={r.photoURL} name={r.displayName} />
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-white truncate">{r.displayName}</p>
                            <p className="text-xs text-text-muted">Wants to be friends</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => acceptRequest(r.connId)}
                            aria-label={`Accept ${r.displayName}`}
                            className="p-2 bg-green-500/20 text-green-500 rounded-lg hover:bg-green-500/40 transition-colors"
                          >
                            <Check size={16} />
                          </button>
                          <button
                            onClick={() => denyRequest(r.connId)}
                            aria-label={`Decline ${r.displayName}`}
                            className="p-2 bg-red-500/20 text-red-500 rounded-lg hover:bg-red-500/40 transition-colors"
                          >
                            <X size={16} />
                          </button>
                        </div>
                      </div>
                    ))
                  ))}

                {tab === "add" && (
                  <div className="space-y-6">
                    <div className="glass p-4 rounded-2xl flex flex-col items-center justify-center text-center gap-2 border border-primary/30 bg-primary/5">
                      <p className="text-sm text-primary font-bold">Your Unique Friend Code</p>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(myCode).catch(() => {});
                          setNotice("Code copied!");
                          setTimeout(() => setNotice(""), 2000);
                        }}
                        className="text-2xl font-mono tracking-widest font-black text-white hover:text-accent cursor-pointer transition-colors"
                        title="Click to copy"
                      >
                        {myCode || "…"}
                      </button>
                      <p className="text-xs text-text-muted">Share this code with a friend!</p>
                    </div>

                    <form onSubmit={handleSearch} className="flex flex-col gap-3">
                      <div className="relative">
                        <Search
                          className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
                          size={18}
                        />
                        <label htmlFor="friend-code" className="sr-only">Friend code</label>
                        <input
                          id="friend-code"
                          type="text"
                          placeholder="Search 8-digit friend code…"
                          value={searchQuery}
                          onChange={(e) => {
                            setSearchQuery(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                            setSearchState("idle");
                          }}
                          maxLength={FRIEND_CODE_LENGTH}
                          className="w-full uppercase font-mono tracking-widest bg-white/5 border border-white/10 rounded-xl py-3 pl-10 pr-4 text-white focus:outline-none focus:border-primary transition-colors"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={
                          searchQuery.length !== FRIEND_CODE_LENGTH || searchState === "searching"
                        }
                        className="w-full py-3 bg-white/10 hover:bg-white/20 text-white font-bold rounded-xl transition-colors disabled:opacity-50"
                      >
                        {searchState === "searching" ? "Searching…" : "Search Player"}
                      </button>
                    </form>

                    <div className="space-y-2">
                      {searchResults.map((res) => (
                        <div
                          key={res.uid}
                          className="glass p-3 rounded-2xl border border-white/5 flex items-center justify-between"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <Avatar uid={res.uid} src={res.photoURL} name={res.displayName} />
                            <p className="text-sm font-bold text-white truncate">{res.displayName}</p>
                          </div>
                          <button
                            onClick={() => sendRequest(res.uid)}
                            disabled={sentTo === res.uid}
                            className="text-xs font-bold bg-primary text-white px-3 py-1.5 rounded-lg hover:bg-accent transition-colors disabled:opacity-60 shrink-0"
                          >
                            {sentTo === res.uid ? "Sent" : "Add"}
                          </button>
                        </div>
                      ))}
                      {searchState === "empty" && (
                        <div className="text-center text-text-muted text-sm mt-4">
                          No player found with that code.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="text-center text-text-muted mt-10">
      <div className="mx-auto opacity-20 mb-4 w-12">{icon}</div>
      <p>{text}</p>
    </div>
  );
}

function Avatar({ uid, src, name }: { uid: string; src?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const fallback = `https://api.dicebear.com/7.x/avataaars/svg?seed=${uid}`;
  return (
    <img
      src={!src || failed ? fallback : src}
      onError={() => setFailed(true)}
      alt={name}
      width={40}
      height={40}
      className="w-10 h-10 rounded-full"
    />
  );
}
