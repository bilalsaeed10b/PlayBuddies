import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, onSnapshot, updateDoc, arrayUnion, serverTimestamp, addDoc, collection, query, orderBy, limit } from 'firebase/firestore';
import { getDatabase, ref as dbRef, set as dbSet, push as dbPush, onValue as dbOnValue, onDisconnect as dbOnDisconnect, remove as dbRemove } from 'firebase/database';

// Firebase web config is public by design (it identifies the project, it does
// not authorise anything — security rules do that). Env vars let you point a
// dev build at a separate project without editing source.
const env = import.meta.env;

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY ?? 'AIzaSyCPdgiF18VF7MyAtVa6r1kRCJaKKqrZsJg',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? 'playbuddies-556cd.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? 'playbuddies-556cd',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET ?? 'playbuddies-556cd.firebasestorage.app',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '741516901024',
  appId: env.VITE_FIREBASE_APP_ID ?? '1:741516901024:web:6ee715ebc6438dfb1f27c5',
  databaseURL: env.VITE_FIREBASE_DATABASE_URL ?? 'https://playbuddies-556cd-default-rtdb.firebaseio.com',
};

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);
export const rtdb = getDatabase(app);
export const googleProvider = new GoogleAuthProvider();

export {
  signInAnonymously, onAuthStateChanged, signInWithPopup,
  doc, setDoc, getDoc, onSnapshot, updateDoc, arrayUnion, serverTimestamp,
  addDoc, collection, query, orderBy, limit,
  dbRef, dbSet, dbPush, dbOnValue, dbOnDisconnect, dbRemove,
};
