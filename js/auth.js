// js/auth.js

import { auth, db } from './api.js';
import { STATE } from './config.js';
import { showLoader, showToast } from './utils.js';
// ... (import lainnya)

export async function handleLogin() {
    const email = document.getElementById('input-user-id').value;
    const password = document.getElementById('input-password').value;
    if (!email || !password) { showToast('Email dan Password harus diisi!', 'warning'); return; }
    
    showLoader(true);
    try {
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        // Jika berhasil, onAuthStateChanged di main.js akan mengambil alih, 
        // sehingga kita tidak perlu memanggil initializeApp() di sini lagi.
    } catch (error) {
        console.error("Login process error:", error); 
        const message = error.code === 'auth/wrong-password' || error.code === 'auth/user-not-found' ? 'Email atau Password salah.' : `Terjadi kesalahan saat login: ${error.message}`;
        showToast(`Login Gagal: ${message}`, 'danger');
        showLoader(false); // KRITIS: Harus nonaktifkan loader jika gagal
    }
}
// ... (lanjutan auth.js)

export async function handleLogout() {
    try {
        await auth.signOut();
        localStorage.removeItem('siPandaiSession');
        localStorage.removeItem('cache_allKelompok');
        localStorage.removeItem('cache_allProdi');
        window.location.reload();
    } catch (error) {
        showToast(`Gagal logout: ${error.message}`, 'danger');
    }
}

export function saveSession(userData) { 
    try { localStorage.setItem('siPandaiSession', JSON.stringify(userData)); } catch (e) {} 
}

// Log Activity Helper
export async function logActivity(action, details = '') {
    // Import sb dynamically or pass it to avoid issues, or assume imported from api.js
    const { sb } = await import('./api.js'); 
    if (!STATE.uid || !STATE.id) return;
    const payload = {
        action: action,
        details: details,
        userId: STATE.id,
        userUid: STATE.uid,
        timestamp: sbTimestamp()
    };
    try { await sb.from('activityLog').insert(payload); } catch (e) {}
}