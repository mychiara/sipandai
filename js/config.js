// js/config.js

// Konfigurasi Firebase
export const firebaseConfig = {
  apiKey: "AIzaSyBrUof5Nc8mgvBov1qvWM363RBUTBzW15o",
  authDomain: "sipandai-bc46f.firebaseapp.com",
  projectId: "sipandai-bc46f",
  storageBucket: "sipandai-bc46f.firebasestorage.app",
  messagingSenderId: "962522187009",
  appId: "1:962522187009:web:d1ea2e7ce9a9e9a22c8700",
  measurementId: "G-CTZ38C68LS"
};

// Konfigurasi Supabase
export const SUPABASE_URL = 'https://ocqnhkxwofvxsarxzlpx.supabase.co'; 
export const SUPABASE_ANON_KEY = 'sb_publishable_xznS8NaOyh5J8ueOtUPPYw_oisX6xla'; 

// Konstanta Global
export const PRODI_SUMMARY_TABLE = 'prodi_summary';
export const RPD_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Ags', 'Sep', 'Okt', 'Nov', 'Des'];
export const GRUB_BELANJA_UTAMA_OPTIONS = [];

// Global STATE
export let STATE = { 
    role: null, id: null, uid: null, currentUserData: null, 
    allKelompok: [], allProdi: [], allDirektoratUids: [],
    allGrubBelanja: [], 
    currentAjuanDataAwal: [], 
    currentAjuanDataPerubahan: [], 
    stagingList: [], 
    selectedAjuanIdsAwal: new Set(), 
    selectedAjuanIdsPerubahan: new Set(),
    allDashboardData: [], 
    cachedDashboardData: [], 
    direktoratSummaryData: [], 
    globalSettings: {},
    beritaAcaraSettings: {},
    currentAjuanType: 'Awal',
    logPageSize: 50,
    currentLogPage: 1
};

// Helper untuk reset state saat logout
export function resetState() {
    STATE.role = null;
    STATE.id = null;
    // ... reset field lainnya jika perlu
}