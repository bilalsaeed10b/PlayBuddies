import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, onSnapshot, updateDoc, arrayUnion, serverTimestamp, getDocFromServer } from 'firebase/firestore';
const firebaseConfig = {
  projectId: "playbuddies-556cd",
  appId: "1:741516901024:web:6ee715ebc6438dfb1f27c5",
  apiKey: "AIzaSyCPdgiF18VF7MyAtVa6r1kRCJaKKqrZsJg",
  authDomain: "playbuddies-556cd.firebaseapp.com",
  storageBucket: "playbuddies-556cd.firebasestorage.app",
  messagingSenderId: "741516901024",
  measurementId: "G-96MQE1FVP8"
};

// Initialize Firebase SDK
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Test connection to Firestore
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if(error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration. ");
    }
  }
}
testConnection();

export { signInAnonymously, onAuthStateChanged, signInWithPopup, doc, setDoc, getDoc, onSnapshot, updateDoc, arrayUnion, serverTimestamp };
