

// Import required Firebase SDK modules
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

// -------------------------------------------
//  Your Firebase project configuration
// -------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyDrjo_HDQ1RRkjA-zXgZtuFovI7zg2yma0",
  authDomain: "kmu-digita-rsc-mnt-system.firebaseapp.com",
  databaseURL: "https://kmu-digita-rsc-mnt-system-default-rtdb.firebaseio.com",
  projectId: "kmu-digita-rsc-mnt-system",
  storageBucket: "kmu-digita-rsc-mnt-system.appspot.com", // ✅ fixed typo: must end with .appspot.com
  messagingSenderId: "908284620214",
  appId: "1:908284620214:web:e76e9a4757c162eea1a517",
  measurementId: "G-JEPQ1YMVNE"
};

// -------------------------------------------
//  Initialize Firebase services
// -------------------------------------------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const rtdb = getDatabase(app);
const storage = getStorage(app);

// -------------------------------------------
//  Export initialized instances
// -------------------------------------------
export { app, auth, db, rtdb, storage };
