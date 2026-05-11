// ── pacepost / Cloud module ─────────────────────────────────
// Wraps Firebase auth + Firestore + Storage behind a small API
// that the rest of the app talks to via `window.Cloud`.
//
// If firebase-config.js has no apiKey, this module short-circuits
// and the app stays local-only (Cloud.isReady === false).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, updateProfile,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, setDoc, getDoc, addDoc, collection,
  query, where, orderBy, limit, getDocs, onSnapshot,
  serverTimestamp, deleteDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

const cfg = window.PACEPOST_FIREBASE_CONFIG || {};
const Cloud = {
  isReady: false,
  user: null,
  _authSubs: new Set(),
  onAuth(cb) { this._authSubs.add(cb); cb(this.user); return () => this._authSubs.delete(cb); },
};
window.Cloud = Cloud;

if (!cfg.apiKey) {
  console.log("[Cloud] no firebase-config.js apiKey — running local-only");
} else {
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  // Firestore with persistent local cache → reads work offline,
  // writes queue and sync when back online.
  let db;
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (e) {
    console.warn("[Cloud] persistent cache unavailable, using memory", e);
    const { getFirestore } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
    db = getFirestore(app);
  }
  const storage = getStorage(app);
  Cloud.isReady = true;

  onAuthStateChanged(auth, (u) => {
    Cloud.user = u ? { uid: u.uid, email: u.email, displayName: u.displayName || u.email?.split("@")[0] || "athlete" } : null;
    Cloud._authSubs.forEach((cb) => { try { cb(Cloud.user); } catch (e) { console.error(e); } });
  });

  Cloud.signIn = async (email, password) => {
    const c = await signInWithEmailAndPassword(auth, email, password);
    return c.user;
  };
  Cloud.signUp = async (email, password, displayName) => {
    const c = await createUserWithEmailAndPassword(auth, email, password);
    if (displayName) await updateProfile(c.user, { displayName });
    await setDoc(doc(db, "users", c.user.uid), {
      displayName: displayName || email.split("@")[0],
      email,
      joinedAt: serverTimestamp(),
    });
    return c.user;
  };
  Cloud.signOut = () => signOut(auth);

  // ─── Activity feed ──────────────────────────────────────────
  Cloud.publishActivity = async (act) => {
    if (!auth.currentUser) throw new Error("not signed in");
    const u = auth.currentUser;
    const payload = {
      uid: u.uid,
      authorName: u.displayName || u.email?.split("@")[0] || "athlete",
      kind: act.kind,
      distanceKm: act.distanceKm || 0,
      elapsedMs: act.elapsedMs || 0,
      pace: act.pace || null,
      calories: act.calories || null,
      elevationGainFt: act.elevationGainFt || null,
      startedAt: act.startedAt || Date.now(),
      endedAt: act.endedAt || Date.now(),
      notes: (act.notes || "").slice(0, 600),
      rpe: act.rpe || null,
      photoUrls: act.photoUrls || [],
      weather: act.weather || null,
      region: act.region || null,
      createdAt: serverTimestamp(),
      localId: act.id,
    };
    const ref = await addDoc(collection(db, "activities"), payload);
    return ref.id;
  };

  Cloud.fetchFeed = async (n = 30) => {
    const q = query(collection(db, "activities"), orderBy("createdAt", "desc"), limit(n));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  };

  // ─── Photos ─────────────────────────────────────────────────
  Cloud.uploadPhoto = async (activityId, blob, idx = 0) => {
    if (!auth.currentUser) throw new Error("not signed in");
    const path = `activities/${auth.currentUser.uid}/${activityId}/photo_${idx}_${Date.now()}.jpg`;
    const r = ref(storage, path);
    await uploadBytes(r, blob, { contentType: "image/jpeg" });
    return await getDownloadURL(r);
  };

  Cloud.attachPhotoToActivity = async (cloudActivityId, photoUrl) => {
    const aref = doc(db, "activities", cloudActivityId);
    const cur = await getDoc(aref);
    const existing = (cur.data()?.photoUrls) || [];
    await updateDoc(aref, { photoUrls: [...existing, photoUrl] });
  };

  // ─── Comments + likes ──────────────────────────────────────
  Cloud.listenComments = (activityId, cb) => {
    const q = query(collection(db, "activities", activityId, "comments"), orderBy("createdAt", "asc"));
    return onSnapshot(q, (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  };
  Cloud.addComment = async (activityId, text) => {
    if (!auth.currentUser) throw new Error("not signed in");
    const u = auth.currentUser;
    await addDoc(collection(db, "activities", activityId, "comments"), {
      uid: u.uid,
      authorName: u.displayName || u.email?.split("@")[0] || "athlete",
      text: text.slice(0, 500),
      createdAt: serverTimestamp(),
    });
  };
  Cloud.deleteComment = async (activityId, commentId) => {
    if (!auth.currentUser) throw new Error("not signed in");
    await deleteDoc(doc(db, "activities", activityId, "comments", commentId));
  };
  Cloud.toggleLike = async (activityId) => {
    if (!auth.currentUser) throw new Error("not signed in");
    const uid = auth.currentUser.uid;
    const lref = doc(db, "activities", activityId, "likes", uid);
    const s = await getDoc(lref);
    if (s.exists()) { await deleteDoc(lref); return false; }
    await setDoc(lref, { createdAt: serverTimestamp() });
    return true;
  };
  Cloud.listenLikes = (activityId, cb) => {
    return onSnapshot(collection(db, "activities", activityId, "likes"), (snap) => {
      cb(new Set(snap.docs.map((d) => d.id)));
    });
  };
}

window.dispatchEvent(new Event("pacepost-cloud-ready"));
