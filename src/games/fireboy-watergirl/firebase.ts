// Bilal Saeed 123
import { db, rtdb, auth, googleProvider } from "@/lib/firebase";
import { 
  signInAnonymously, onAuthStateChanged, signInWithPopup, 
} from 'firebase/auth';
import { 
  doc, setDoc, getDoc, onSnapshot, updateDoc, arrayUnion, serverTimestamp 
} from 'firebase/firestore';
import { 
  ref, set, onValue, off, update, onDisconnect 
} from 'firebase/database';

export { 
  db, rtdb, auth, googleProvider,
  signInAnonymously, onAuthStateChanged, signInWithPopup, 
  doc, setDoc, getDoc, onSnapshot, updateDoc, arrayUnion, serverTimestamp,
  ref, set, onValue, off, update, onDisconnect
};
// Bilal Saeed 123
