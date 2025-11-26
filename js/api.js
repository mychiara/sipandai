// js/api.js
import { firebaseConfig, SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Init Firebase
firebase.initializeApp(firebaseConfig);
export const db = firebase.firestore();
export const auth = firebase.auth();
export const serverTimestamp = firebase.firestore.FieldValue.serverTimestamp;
export const firestoreTimestamp = firebase.firestore.Timestamp;
export const deleteField = firebase.firestore.FieldValue.delete;

// Init Supabase
const { createClient } = supabase; 
export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Helper untuk nama tabel
export function getAjuanTableName(tipe) {
    if (!tipe) return 'ajuan';
    if (tipe === 'Awal') return 'ajuan';
    const match = tipe.match(/Perubahan (\d+)/);
    if (match) {
        const rev = parseInt(match[1], 10);
        if (rev >= 1 && rev <= 30) return `ajuanrev${rev}`;
    }
    // Fallback logic
    return 'ajuanrev1'; // Sesuaikan dengan logic tahap aktif
}