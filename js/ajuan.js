// js/ajuan.js
import { sb, getAjuanTableName, db } from './api.js';
import { STATE, RPD_MONTHS, GRUB_BELANJA_UTAMA_OPTIONS } from './config.js';
import { 
    showLoader, showToast, escapeHtml, getColorForProdi, sanitizeTipeForCSS, 
    setElValue, getSafeValue, getMonthlyKey, exportContainerToPDF, printContainer, 
    safeAddClickListener, getElChecked, setElChecked, exportTableToExcel, formatBreakdown 
} from './utils.js';
import { logActivity } from './auth.js';
import { recalculateProdiSummary, updateProdiPaguInfo, loadDashboardData } from './dashboard.js';
import { refreshProdiData } from './admin.js'; // Untuk mendapatkan daftar prodi/unit

// --- UI / SETTINGS HELPERS ---
export function updatePerubahanUI(settings) {
    // ... (Logika dari script.js asli untuk mengatur tampilan navigasi Perubahan)
}

export function setupExportListeners() {
    // ... (Logika binding tombol export dan print)
    // KRITIS: Anda harus memindahkan semua binding print/export dari script.js asli ke sini
}

export function setupNotificationListener() {
    // ... (Logika Firebase listener)
}

// --- AJUAN FETCH & RENDER ---

export function refreshAjuanTableAwal(forceRefresh = false) {
    // ... (Logika controller untuk Awal)
}
export function refreshAjuanTablePerubahan(forceRefresh = false) {
    // ... (Logika controller untuk Perubahan)
}
// export function refreshAjuanTable(tipe) { ... } // (Asumsi ini fungsi internal yang dipanggil oleh Awal/Perubahan)

// --- MATRIX SEMULA MENJADI ---
// KRITIS: Pastikan ini diekspor!
export async function loadMatrixSemulaMenjadi() {
    // ... (Salin seluruh logika loadMatrixSemulaMenjadi dari script.js asli)
}

// --- CRUD AJUAN/RPD/REALISASI (FUNGSI GLOBAL YANG DIPANGGIL HTML) ---

window.openHistoryModal = async (id, nama) => { 
    // ... (Implementasi)
};
window.deleteAjuan = async (id, tipe) => {
    // ... (Implementasi)
};
// ... (Tambahkan binding window lainnya seperti openEditModal, saveRPD, saveRealisasi, dll.)