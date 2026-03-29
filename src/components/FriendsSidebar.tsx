"use client";

import { useEffect, useState } from "react";
import { collection, query, where, onSnapshot, getDocs, setDoc, doc, deleteDoc, serverTimestamp, getDoc, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuthStore } from "@/store/useAuthStore";
import { Users, X, UserPlus, Check, MessageCircle, Search } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function FriendsSidebar() {
  const { user } = useAuthStore();
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<"friends" | "requests" | "add">("friends");

  const [friends, setFriends] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [myCode, setMyCode] = useState<string>("");

  useEffect(() => {
    if (!user) return;

    // Fetch my profile once to get my friendCode
    getDoc(doc(db, "users", user.uid)).then(snap => {
      if (snap.exists()) setMyCode(snap.data().friendCode || "");
    });

    // Listen to connections collection
    const q = query(collection(db, "connections"), where("participants", "array-contains", user.uid));
    const unsub = onSnapshot(q, async (snap) => {
      const allConnections = snap.docs.map(d => ({ id: d.id, ...d.data() } as any));
      
      const accepted: any[] = [];
      const pending: any[] = [];

      for (const conn of allConnections) {
        const otherUid = conn.participants.find((p: string) => p !== user.uid);
        if (!otherUid) continue;

        // Fetch other user profile
        try {
           const profileSnap = await getDoc(doc(db, "users", otherUid));
           if (!profileSnap.exists()) continue;
           const profile = profileSnap.data();

           if (conn.status === "accepted") {
             accepted.push({ ...profile, connId: conn.id });
           } else if (conn.status === "pending" && conn.senderId !== user.uid) {
             // We received this request
             pending.push({ ...profile, connId: conn.id });
           }
        } catch (e) {
           console.error("Error fetching friend profile", e);
        }
      }
      setFriends(accepted);
      setRequests(pending);
    });

    return () => unsub();
  }, [user]);

  const friendsCount = friends.length;

  useEffect(() => {
    if (!user) return;
    const { stats, setStats } = useAuthStore.getState();
    if (stats && stats.friendsOnline !== friendsCount) {
      setStats({ ...stats, friendsOnline: friendsCount });
    }
  }, [friendsCount, user]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || !user) return;

    setIsSearching(true);
    try {
      const formattedQuery = searchQuery.trim().toUpperCase();
      const usersRef = collection(db, "users");
      const q = query(usersRef, where("friendCode", "==", formattedQuery));
      const snap = await getDocs(q);
      
      const results = snap.docs
        .map(d => d.data())
        .filter(d => d.uid !== user.uid);

      setSearchResults(results.slice(0, 10)); // Limit 10
    } catch (e) {
      console.error("Search failed:", e);
    }
    setIsSearching(false);
  };

  const sendRequest = async (targetUid: string) => {
    if (!user) return;
    const sortedIds = [user.uid, targetUid].sort();
    const connId = `${sortedIds[0]}_${sortedIds[1]}`;
    await setDoc(doc(db, "connections", connId), {
      participants: sortedIds,
      status: "pending",
      senderId: user.uid,
      createdAt: serverTimestamp(),
    });
  };

  const acceptRequest = async (connId: string) => {
    await setDoc(doc(db, "connections", connId), { status: "accepted" }, { merge: true });
  };

  const denyRequest = async (connId: string) => {
    await deleteDoc(doc(db, "connections", connId));
  };

  const inviteFriend = async (friendId: string) => {
    if (!user) return;
    try {
      // Check if user is in a lobby themselves to invite them to
      const q = query(collection(db, "lobbies"), where("hostId", "==", user.uid));
      const snaps = await getDocs(q);
      
      let lobbyToInvite = "";
      if (!snaps.empty) {
        lobbyToInvite = snaps.docs[0].id;
      } else {
        const searchParams = new URLSearchParams(window.location.search);
        lobbyToInvite = searchParams.get("room") || "";
      }

      if (!lobbyToInvite) {
        alert("You must be navigating inside a Lobby room to send an invite!");
        return;
      }

      await addDoc(collection(db, "invites"), {
        targetId: friendId,
        fromUid: user.uid,
        fromName: user.displayName,
        roomId: lobbyToInvite,
        timestamp: Date.now(),
        expiresAt: new Date(Date.now() + 2 * 60 * 1000)
      });
      alert("Invite sent to friend!");
    } catch (e) {
      console.error("Invite error:", e);
      alert("Error sending invite");
    }
  };

  if (!user) return null;

  return (
    <>
      {/* Floating Toggle Button */}
      {!isOpen && (
        <motion.button
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 z-50 p-4 rounded-full bg-primary/80 backdrop-blur-md shadow-[0_0_20px_#ff4400] text-white hover:bg-primary transition-colors flex items-center gap-2"
        >
          <Users size={24} />
          <span className="font-bold hidden sm:inline-block">Friends ({friendsCount})</span>
          {requests.length > 0 && (
            <span className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 rounded-full text-xs flex items-center justify-center font-black animate-bounce">
              {requests.length}
            </span>
          )}
        </motion.button>
      )}

      {/* Sidebar Overlay */}
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
              {/* Header */}
              <div className="p-6 border-b border-white/10 flex items-center justify-between">
                <h2 className="text-2xl font-black text-white flex items-center gap-3">
                  <Users className="text-primary" /> Friends
                </h2>
                <button onClick={() => setIsOpen(false)} className="p-2 text-white/50 hover:text-white transition-colors hover:bg-white/10 rounded-xl">
                  <X size={24} />
                </button>
              </div>

              {/* Tabs */}
              <div className="flex px-4 pt-4 gap-2">
                {[
                  { id: "friends", label: `Friends (${friendsCount})` },
                  { id: "requests", label: `Requests (${requests.length})` },
                  { id: "add", label: "Add Friend" }
                ].map(t => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id as any)}
                    className={`flex-1 py-2 px-2 text-xs font-bold rounded-t-xl transition-colors border-b-2 ${
                      tab === t.id ? "border-primary text-primary bg-white/5" : "border-transparent text-text-muted hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Content area */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                
                {/* FRIENDS TAB */}
                {tab === "friends" && (
                  <>
                    {friends.length === 0 ? (
                      <div className="text-center text-text-muted mt-10">
                        <Users size={48} className="mx-auto opacity-20 mb-4" />
                        <p>No friends yet.</p>
                      </div>
                    ) : (
                      friends.map(f => (
                        <div key={f.uid} className="glass p-3 rounded-2xl border border-white/5 flex items-center justify-between group">
                          <div className="flex items-center gap-3">
                            <img src={f.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${f.uid}`} alt={f.displayName} className="w-10 h-10 rounded-full" />
                            <div>
                              <p className="text-sm font-bold text-white">{f.displayName}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => inviteFriend(f.uid)}
                            className="bg-primary hover:bg-primary/80 text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors"
                            title="Invite to Lobby"
                          >
                            <MessageCircle size={14} /> Invite
                          </button>
                        </div>
                      ))
                    )}
                  </>
                )}

                {/* REQUESTS TAB */}
                {tab === "requests" && (
                  <>
                    {requests.length === 0 ? (
                      <div className="text-center text-text-muted mt-10">
                        <UserPlus size={48} className="mx-auto opacity-20 mb-4" />
                        <p>No pending requests.</p>
                      </div>
                    ) : (
                      requests.map(r => (
                        <div key={r.uid} className="glass p-3 rounded-2xl border border-white/5 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <img src={r.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${r.uid}`} alt={r.displayName} className="w-10 h-10 rounded-full" />
                            <div>
                              <p className="text-sm font-bold text-white">{r.displayName}</p>
                              <p className="text-xs text-text-muted">Wants to be friends</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <button onClick={() => acceptRequest(r.connId)} className="p-2 bg-green-500/20 text-green-500 rounded-lg hover:bg-green-500/40 transition-colors">
                              <Check size={16} />
                            </button>
                            <button onClick={() => denyRequest(r.connId)} className="p-2 bg-red-500/20 text-red-500 rounded-lg hover:bg-red-500/40 transition-colors">
                              <X size={16} />
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </>
                )}

                {/* ADD FRIEND TAB */}
                {tab === "add" && (
                  <div className="space-y-6">

                    <div className="glass p-4 rounded-2xl flex flex-col items-center justify-center text-center gap-2 border border-primary/30 bg-primary/5">
                       <p className="text-sm text-primary font-bold">Your Unique Friend Code</p>
                       <div 
                         onClick={() => {
                           navigator.clipboard.writeText(myCode);
                           alert("Copied Code: " + myCode);
                         }}
                         className="text-2xl font-mono tracking-widest font-black text-white hover:text-accent cursor-pointer transition-colors"
                         title="Click to copy"
                       >
                          {myCode || "..."}
                       </div>
                       <p className="text-xs text-text-muted">Share this code with a friend!</p>
                    </div>

                    <form onSubmit={handleSearch} className="flex flex-col gap-3">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={18} />
                        <input
                          type="text"
                          placeholder="Search 8-digit friend code..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value.toUpperCase())}
                          maxLength={8}
                          className="w-full uppercase font-mono tracking-widest bg-white/5 border border-white/10 rounded-xl py-3 pl-10 pr-4 text-white focus:outline-none focus:border-primary transition-colors"
                        />
                      </div>
                      <button 
                        type="submit" 
                        disabled={searchQuery.trim().length !== 8 || isSearching}
                        className="w-full py-3 bg-white/10 hover:bg-white/20 text-white font-bold rounded-xl transition-colors disabled:opacity-50"
                      >
                        {isSearching ? "Searching..." : "Search Player"}
                      </button>
                    </form>

                    <div className="space-y-2">
                      {searchResults.map(res => (
                        <div key={res.uid} className="glass p-3 rounded-2xl border border-white/5 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <img src={res.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${res.uid}`} alt={res.displayName} className="w-10 h-10 rounded-full" />
                            <p className="text-sm font-bold text-white">{res.displayName}</p>
                          </div>
                          <button
                            onClick={() => sendRequest(res.uid)}
                            className="text-xs font-bold bg-primary text-white px-3 py-1.5 rounded-lg hover:bg-accent transition-colors"
                          >
                            Add
                          </button>
                        </div>
                      ))}
                      {searchResults.length === 0 && searchQuery.trim() !== "" && !isSearching && (
                         <div className="text-center text-text-muted text-sm mt-4">
                            No player found with code {searchQuery}.
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
