import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getDatabase } from "firebase/database";

// Firebase web config is public by design — it identifies the project, it does
// not authorise anything. Access is controlled by firestore.rules and
// database.rules.json. Env vars let a build target a different project.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "AIzaSyCPdgiF18VF7MyAtVa6r1kRCJaKKqrZsJg",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "playbuddies-556cd.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "playbuddies-556cd",
  storageBucket:
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "playbuddies-556cd.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "741516901024",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "1:741516901024:web:6ee715ebc6438dfb1f27c5",
  databaseURL:
    process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ??
    "https://playbuddies-556cd-default-rtdb.asia-southeast1.firebasedatabase.app",
};

// getApps() guards against re-initialising across hot reloads.
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);
export const rtdb = getDatabase(app);
export const googleProvider = new GoogleAuthProvider();

export default app;
