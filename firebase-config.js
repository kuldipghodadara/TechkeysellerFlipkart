const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const path = require('path');

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT || path.join(__dirname, 'serviceAccountKey.json');
const serviceAccount = require(serviceAccountPath);

const app = initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore(app);
const auth = getAuth(app);

module.exports = { app, db, auth, FieldValue, Timestamp };
