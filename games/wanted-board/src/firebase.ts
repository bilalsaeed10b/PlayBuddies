import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc, onSnapshot, updateDoc, serverTimestamp } from 'firebase/firestore';

// Same project as the platform, so the lobby this game is launched from is the
// lobby it reads.
//
// The web config is public by design: it identifies the project, it does not
// authorise anything — security rules do that.
const env = import.meta.env;

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY ?? 'AIzaSyCPdgiF18VF7MyAtVa6r1kRCJaKKqrZsJg',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? 'playbuddies-556cd.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? 'playbuddies-556cd',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET ?? 'playbuddies-556cd.firebasestorage.app',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '741516901024',
  appId: env.VITE_FIREBASE_APP_ID ?? '1:741516901024:web:6ee715ebc6438dfb1f27c5',
  databaseURL: env.VITE_FIREBASE_DATABASE_URL ?? 'https://playbuddies-556cd-default-rtdb.asia-southeast1.firebasedatabase.app',
};

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);

export { onAuthStateChanged, doc, getDoc, setDoc, onSnapshot, updateDoc, serverTimestamp };
