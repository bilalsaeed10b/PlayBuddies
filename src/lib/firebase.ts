
// Bilal Saeed 123
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyCPdgiF18VF7MyAtVa6r1kRCJaKKqrZsJg",
  authDomain: "playbuddies-556cd.firebaseapp.com",
  projectId: "playbuddies-556cd",
  storageBucket: "playbuddies-556cd.firebasestorage.app",
  messagingSenderId: "741516901024",
  appId: "1:741516901024:web:6ee715ebc6438dfb1f27c5",
  measurementId: "G-96MQE1FVP8",
  databaseURL: "https://playbuddies-556cd-default-rtdb.firebaseio.com"
};

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const rtdb = getDatabase(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export default app;
// Bilal Saeed 123

