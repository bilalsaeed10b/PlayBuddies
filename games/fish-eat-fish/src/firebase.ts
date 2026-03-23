// Bilal Saeed xxxxx
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCPdgiF18VF7MyAtVa6r1kRCJaKKqrZsJg",
  authDomain: "playbuddies-556cd.firebaseapp.com",
  projectId: "playbuddies-556cd",
  storageBucket: "playbuddies-556cd.firebasestorage.app",
  messagingSenderId: "741516901024",
  appId: "1:741516901024:web:6ee715ebc6438dfb1f27c5",
  measurementId: "G-96MQE1FVP8"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
// Bilal Saeed xxxxx
