import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ExpoFileSystem from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import {
  Job,
  JobStatus,
  User,
  AuthResponse,
  InventoryItem,
  MaterialUsed,
  SyncMutation,
  SyncMutationType,
  SyncResponsePayload,
  QueuedAction,
} from '../types';
import NetInfo from '@react-native-community/netinfo';
import {
  getCachedJobs,
  saveCachedJobs,
  getCachedJobById,
  updateCachedJobLocally,
  removeCachedJob,
  enqueueOfflineAction,
  generateUUID,
  flushOfflineQueue,
  getOfflineSyncQueue,
  removeFromOfflineQueue,
  getLastSyncTimestamp,
  saveCachedStaff,
  getCachedStaff,
  clearCorruptedCacheOnAppStart,
  savePhotoToLocalDisk,
  cleanupSyncedJobPhotos,
  getAuthToken,
  getAuthUser,
  saveAuthSession,
  clearAuthSession as clearAuthSessionStorage,
  getApiUrlOverride,
  setApiUrlOverride,
  API_URL_OVERRIDE_KEY,
} from './storage';

const FileSystem = {
  ...ExpoFileSystem,
  ...LegacyFileSystem,
};

export {
  clearCorruptedCacheOnAppStart,
  savePhotoToLocalDisk,
  cleanupSyncedJobPhotos,
  getAuthToken,
  getAuthUser,
  saveAuthSession,
  clearAuthSession as clearAuthSessionStorage,
  getApiUrlOverride,
  setApiUrlOverride,
  API_URL_OVERRIDE_KEY,
  updateCachedJobLocally,
  removeCachedJob,
};

import Constants from 'expo-constants';
import { NativeModules, Alert } from 'react-native';

/**
 * Dynamically extract development machine's host IP from Expo's Constants.expoConfig?.hostUri
 * or NativeModules.SourceCode.scriptURL so it automatically tracks the computer's current Wi-Fi IP
 * when running on a physical phone via Expo Go.
 */
export function extractExpoHostIp(): string | null {
  try {
    // 1. Check Expo Constants hostUri (e.g. "192.168.1.10:8081" in Expo Go)
    const hostUri =
      Constants.expoConfig?.hostUri ||
      (Constants as any).manifest2?.extra?.expoGo?.debuggerHost ||
      (Constants as any).manifest?.debuggerHost;
    if (hostUri && typeof hostUri === 'string') {
      const host = hostUri.split(':')[0];
      if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '10.0.2.2') {
        return host;
      }
    }
  } catch {
    // Ignore lookup errors
  }

  try {
    // 2. Check NativeModules SourceCode scriptURL (e.g. "http://192.168.1.10:8081/index.bundle?...")
    const scriptURL: string | undefined = NativeModules?.SourceCode?.scriptURL;
    if (scriptURL && typeof scriptURL === 'string' && scriptURL.includes('://')) {
      const parts = scriptURL.split('://')[1]?.split(':');
      const host = parts?.[0];
      if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '10.0.2.2') {
        return host;
      }
    }
  } catch {
    // Ignore lookup errors
  }

  return null;
}

export const PRODUCTION_API_URL = 'https://fieldops-platform-server.vercel.app/api';

export function normalizeApiUrl(rawUrl: string): string {
  const cleaned = rawUrl.trim().replace(/\/+$/, '');
  return cleaned.endsWith('/api') ? cleaned : `${cleaned}/api`;
}

export function detectExpoHostLanUrl(): string {
  const envUrl =
    typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_API_URL
      ? process.env.EXPO_PUBLIC_API_URL.trim()
      : '';
  if (envUrl) {
    return normalizeApiUrl(envUrl);
  }
  const dynamicHost = extractExpoHostIp();
  if (dynamicHost) {
    return `http://${dynamicHost}:5000/api`;
  }
  return PRODUCTION_API_URL;
}

const configuredEnvUrl =
  typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_API_URL
    ? process.env.EXPO_PUBLIC_API_URL.trim()
    : '';
const normalizedEnvUrl = configuredEnvUrl ? normalizeApiUrl(configuredEnvUrl) : '';

export const DEFAULT_LAN_API_URL = detectExpoHostLanUrl();

export const CANDIDATE_BASE_URLS = Array.from(
  new Set([
    normalizedEnvUrl,
    PRODUCTION_API_URL,
    DEFAULT_LAN_API_URL,
    'http://localhost:5000/api',
  ].filter(Boolean) as string[])
);

// Prioritize configured URL, then permanent production URL, then dynamic LAN URL
export let API_BASE_URL = normalizedEnvUrl || PRODUCTION_API_URL || DEFAULT_LAN_API_URL;

// Load explicit manual API URL override from storage on app start
getApiUrlOverride()
  .then((override) => {
    if (override && override.startsWith('http')) {
      API_BASE_URL = normalizeApiUrl(override);
    }
  })
  .catch(() => {});

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

export async function setApiBaseUrl(url: string): Promise<void> {
  const normalized = normalizeApiUrl(url);
  API_BASE_URL = normalized;
  await setApiUrlOverride(normalized);
}

/**
 * Execute network fetch with automatic fallback across candidate base URLs.
 * Probes the active LAN base URL first; if connection is refused/times out, seamlessly tries
 * the alternative candidate base URLs.
 */
export async function fetchWithBaseUrlFallback(
  endpoint: string,
  options?: RequestInit,
  timeoutMs: number = 15000
): Promise<Response> {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const token = await getAuthToken();

  const authHeaders: Record<string, string> = {};
  if (token) {
    authHeaders['Authorization'] = `Bearer ${token}`;
  }

  const manualOverride = await getApiUrlOverride();
  const urlsToTry = Array.from(
    new Set([
      manualOverride ? normalizeApiUrl(manualOverride) : null,
      API_BASE_URL,
      PRODUCTION_API_URL,
      DEFAULT_LAN_API_URL,
      ...CANDIDATE_BASE_URLS,
    ].filter(Boolean) as string[])
  );

  let lastError: any = null;

  for (let i = 0; i < urlsToTry.length; i++) {
    const candidateBase = urlsToTry[i];
    const fullUrl = `${candidateBase}${cleanEndpoint}`;

    const controller = new AbortController();
    const isSync = cleanEndpoint.includes('/sync');
    const currentTimeout = isSync ? Math.min(timeoutMs, 15000) : Math.min(timeoutMs, 8000);
    const timeoutId = setTimeout(() => controller.abort(), currentTimeout);

    try {
      const response = await fetch(fullUrl, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          ...(options?.headers as Record<string, string>),
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Successfully connected! Update active runtime base URL
      if (candidateBase !== API_BASE_URL) {
        console.log(`[API] 🔄 Switched active API base URL to: ${candidateBase}`);
        API_BASE_URL = candidateBase;
      }

      // Intercept 401 ACCOUNT_DELETED / revoked responses for immediate mobile auto-logout
      if (response.status === 401 && !cleanEndpoint.includes('/auth/login')) {
        console.warn('[API Auth Interceptor] 401 / ACCOUNT_DELETED received on authenticated endpoint. Triggering auto-logout.');
        await triggerImmediateLogout();
      }

      return response;
    } catch (err: any) {
      clearTimeout(timeoutId);
      lastError = err;
      if (controller.signal.aborted || err.name === 'AbortError') {
        console.warn(`[API] Timeout reaching ${fullUrl} (${currentTimeout}ms). Trying fallback...`);
      } else {
        console.warn(`[API] Connection failed to ${fullUrl}:`, err?.message || err, '. Trying fallback...');
      }
    }
  }

  throw lastError || new Error(`Network request failed on all candidate endpoints: ${cleanEndpoint}`);
}

let onAccountRevokedCallback: (() => void) | null = null;
let cachedToken: string | null = null;
let currentUser: User | null = null;

export function registerAccountRevokedHandler(handler: () => void): void {
  onAccountRevokedCallback = handler;
}

/**
 * Clear in-memory auth state and wipe all session tokens from AsyncStorage
 */
export async function clearAuthSession(): Promise<void> {
  cachedToken = null;
  currentUser = null;
  try {
    await AsyncStorage.multiRemove([
      'auth_token',
      'user_profile',
      'fieldops_user',
      'fieldops_tech_id',
      'offline_jobs',
      'user',
      'token',
      '@auth_user',
      '@fieldops_auth_token_v2',
      '@fieldops_auth_user_v2',
      'active_staff_id',
      'active_staff_data',
      'jobs_cache',
      'offline_sync_queue',
      '@fieldops_jobs_cache',
      '@fieldops_offline_sync_queue',
      '@fieldops_auth_token',
      '@fieldops_auth_user',
      '@fieldops_last_sync_timestamp',
      'has_prompted_gps',
    ]);
    await AsyncStorage.removeItem('has_prompted_gps');
    await clearAuthSessionStorage();
  } catch (err) {
    console.warn('[Auth] Error clearing AsyncStorage:', err);
  }
}

export async function triggerImmediateLogout(): Promise<void> {
  console.log('[Auth] Immediately revoking mobile session and clearing stored tokens...');
  await clearAuthSession();
  if (onAccountRevokedCallback) {
    onAccountRevokedCallback();
  }
}

export const onForceSignOut = triggerImmediateLogout;

/**
 * Authenticate technician or staff member via real HTTP POST /api/auth/login.
 * Completely eliminates any mock/simulated login fallback.
 */
export async function loginUser(email: string, password: string): Promise<AuthResponse> {
  const cleanEmail = email.trim();
  const cleanPassword = password.trim();

  const response = await fetchWithBaseUrlFallback(
    '/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cleanEmail, password: cleanPassword }),
    },
    15000
  );

  const data = await response.json().catch(() => null);

  if (!response.ok || response.status === 401 || response.status === 403 || !data) {
    throw new Error(
      data?.message ||
      data?.error ||
      'You are not a member of this company. Contact your supervisor to be added to the team directory.'
    );
  }

  const userObj = data.user || data.technician;
  if (!data.token || !userObj) {
    throw new Error('Malformed authentication response from server');
  }

  // Update in-memory session variables
  cachedToken = data.token;
  currentUser = userObj;

  // Save session ONLY if server explicitly confirmed success
  await AsyncStorage.setItem('auth_token', data.token);
  await AsyncStorage.setItem('user_profile', JSON.stringify(userObj));
  await saveAuthSession(data.token, userObj);

  return {
    token: data.token,
    user: userObj,
  };
}

/**
 * Sign out current authenticated technician and clear stored credentials
 */
export async function logoutUser(): Promise<void> {
  await clearAuthSession();
}

/**
 * Resolve a photo URI just-in-time for network transmission.
 * Reads local `file:///...` disk paths via `FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.Base64 })`
 * right before the network request payload is dispatched, keeping AsyncStorage lightweight and immune to Android CursorWindow limits.
 */
export async function resolvePhotoUriForUpload(uri?: string | null): Promise<string | null> {
  if (!uri) return null;
  if (uri.startsWith('data:image/') || uri.startsWith('http://') || uri.startsWith('https://')) {
    return uri;
  }

  // Hydrate from dedicated individual AsyncStorage photo storage key if referenced
  if (uri.startsWith('@fieldops_photo_')) {
    const stored = await AsyncStorage.getItem(uri).catch(() => null);
    if (stored) return stored;
  }

  try {
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    if (base64) {
      return `data:image/jpeg;base64,${base64}`;
    }
  } catch (fsErr) {
    console.warn(`FileSystem.readAsStringAsync failed for ${uri}, attempting Blob fallback:`, fsErr);
  }

  try {
    const response = await fetch(uri);
    const blob = await response.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('FileReader did not yield string'));
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    if (dataUrl && dataUrl.startsWith('data:')) {
      return dataUrl;
    }
  } catch (blobErr) {
    console.warn(`FileReader blob conversion failed for ${uri}:`, blobErr);
  }

  return uri;
}

/**
 * Resolve any local file URIs inside a request payload just-in-time before sending over HTTP.
 * Sends beforePhotoUrl and afterPhotoUrl once (without duplicating multi-megabyte base64 strings).
 */
export async function resolvePayloadPhotosForUpload(body: any): Promise<any> {
  if (!body || typeof body !== 'object') return body;

  const resolved = { ...body };

  if (resolved.beforePhoto || resolved.beforePhotoUrl) {
    const rawBefore = resolved.beforePhotoUrl || resolved.beforePhoto;
    const converted = await resolvePhotoUriForUpload(rawBefore);
    resolved.beforePhoto = converted;
    resolved.beforePhotoUrl = converted;
  }
  if (resolved.afterPhoto || resolved.afterPhotoUrl) {
    const rawAfter = resolved.afterPhotoUrl || resolved.afterPhoto;
    const converted = await resolvePhotoUriForUpload(rawAfter);
    resolved.afterPhoto = converted;
    resolved.afterPhotoUrl = converted;
  }
  if (resolved.signatureData || resolved.signatureSvg) {
    let sig = resolved.signatureSvg || resolved.signatureData;
    if (typeof sig === 'string' && sig.startsWith('@fieldops_sig_')) {
      const storedSig = await AsyncStorage.getItem(sig).catch(() => null);
      if (storedSig) sig = storedSig;
    }
    resolved.signatureSvg = sig;
    resolved.signatureData = sig;
  }
  if (resolved.notes || resolved.completionNotes) {
    const notesVal = resolved.notes || resolved.completionNotes;
    resolved.notes = notesVal;
    resolved.completionNotes = notesVal;
  }

  return resolved;
}

/**
 * Network request wrapper with candidate URL fallback (LAN IP, Android emulator, adb reverse)
 */
export async function apiRequest<T>(
  endpoint: string,
  options?: RequestInit,
  customTimeoutMs?: number
): Promise<T> {
  const timeoutMs =
    customTimeoutMs || (endpoint.includes('/sync') ? 15000 : 8000);

  const response = await fetchWithBaseUrlFallback(endpoint, options, timeoutMs);

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    if (
      response.status === 401 ||
      response.status === 403 ||
      errorBody.includes('NOT_A_MEMBER') ||
      errorBody.includes('ACCOUNT_DELETED') ||
      errorBody.includes('revoked') ||
      errorBody.includes('removed') ||
      errorBody.includes('deactivated')
    ) {
      console.warn('[API Interceptor] 401/403 or revocation received from server. Triggering immediate force logout.');
      await AsyncStorage.multiRemove(['user', 'token', 'cached_jobs', 'has_prompted_gps']);
      await AsyncStorage.removeItem('has_prompted_gps');
      await triggerImmediateLogout();
      Alert.alert(
        'Access Revoked',
        'Your account has been removed from the team directory. Please contact your dispatch supervisor.'
      );
      const err = new Error('NOT_A_MEMBER: Account deactivated. You are no longer authorized to view work orders.');
      (err as any).status = response.status;
      (err as any).code = 'NOT_A_MEMBER';
      throw err;
    }
    throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorBody}`);
  }

  return await response.json();
}

/**
 * Helper to check if a cached job is marked as unsynced locally
 */
function isJobLocallyUnsynced(job: Job): boolean {
  if (job.conflict === true) {
    return false;
  }
  if (job.pending_sync === true || job.is_synced === false) {
    return true;
  }
  if (job.pending_sync === false || job.is_synced === true) {
    return false;
  }
  return (
    Boolean(job.clientUpdatedAt) &&
    (!job.syncedAt ||
      new Date(job.clientUpdatedAt!).getTime() - new Date(job.syncedAt!).getTime() > 3000)
  );
}

/**
 * Extract jobId from an action endpoint if jobId was not explicitly set
 */
function resolveActionJobId(endpoint?: string, explicitJobId?: string): string | undefined {
  if (explicitJobId) return explicitJobId;
  if (!endpoint) return undefined;
  const match = endpoint.match(/\/jobs\/([^/?#]+)/);
  return match?.[1];
}

/**
 * Fetch work orders assigned exclusively to the authenticated technician's user ID.
 * Flushes any pending offline actions first, then fetches authoritative jobs from server.
 * If network request fails, transparently returns cached jobs for the authenticated user.
 */
export async function getJobs(
  assignedTechId?: string,
  options?: { skipOfflineSync?: boolean }
): Promise<{ jobs: Job[]; fromCache: boolean }> {
  const authUser = await getAuthUser();
  const effectiveTechId = assignedTechId || authUser?.id;

  // 1. Opportunistically flush any pending offline queue items BEFORE fetching fresh jobs (only if not background sync)
  if (!options?.skipOfflineSync) {
    try {
      await syncOfflineData();
    } catch (syncErr) {
      console.warn('Pre-fetch opportunistic sync warning:', syncErr);
    }
  }

  try {
    const query = effectiveTechId ? `?assignedTechId=${encodeURIComponent(effectiveTechId)}` : '';
    const freshJobs = await apiRequest<Job[]>(`/jobs${query}`);
    const scopedServerJobs = effectiveTechId
      ? freshJobs.filter(
          (j) => !j.technicianId || j.technicianId === effectiveTechId || j.technician?.id === effectiveTechId
        )
      : freshJobs;

    // Merge any remaining offline queued actions or unresolved conflicts on top of fresh server jobs
    const [queue, existingCachedJobs] = await Promise.all([
      getOfflineSyncQueue(),
      getCachedJobs(effectiveTechId),
    ]);
    const cachedById = new Map(existingCachedJobs.map((j) => [j.id, j]));

    const mergedJobs = scopedServerJobs.map((freshJob) => {
      const existingCached = cachedById.get(freshJob.id);
      if (existingCached?.conflict === true) {
        return {
          ...existingCached,
          serverConflictState: freshJob,
        };
      }

      const pendingActions = queue.filter(
        (q) => q.jobId === freshJob.id || (q.endpoint && q.endpoint.includes(freshJob.id))
      );
      if (pendingActions.length > 0) {
        let merged: Job = {
          ...freshJob,
          is_synced: false,
          pending_sync: true,
          syncedAt: null,
        };
        for (const action of pendingActions) {
          if (action.body) {
            merged = {
              ...merged,
              ...action.body,
              status: action.body.status || (action.endpoint.includes('/complete') ? 'COMPLETED' : merged.status),
              clientUpdatedAt: action.body.clientUpdatedAt || new Date(action.timestamp).toISOString(),
              is_synced: false,
              pending_sync: true,
              syncedAt: null,
            };
          }
        }
        return merged;
      }

      const syncedTimestamp =
        freshJob.syncedAt || freshJob.updatedAt || new Date().toISOString();
      return {
        ...freshJob,
        syncedAt: syncedTimestamp,
        is_synced: true,
        pending_sync: false,
        conflict: false,
      };
    });

    await saveCachedJobs(mergedJobs, effectiveTechId);

    return { jobs: mergedJobs, fromCache: false };
  } catch (networkError: any) {
    const errorMsg = networkError?.message || '';
    if (
      networkError?.status === 401 ||
      networkError?.isAuthDeleted === true ||
      errorMsg.includes('401') ||
      errorMsg.includes('ACCOUNT_DELETED') ||
      errorMsg.includes('ACCOUNT_NOT_FOUND') ||
      errorMsg.includes('revoked') ||
      errorMsg.includes('removed')
    ) {
      console.warn('[API getJobs] Auth failure / ACCOUNT_DELETED received. Blocking cache fallback.');
      await onForceSignOut();
      throw networkError;
    }
    console.warn('Network fetch failed, falling back to local cache:', networkError);
    const cached = await getCachedJobs(effectiveTechId);
    if (cached) {
      const queue = await getOfflineSyncQueue();
      const mergedCached = cached.map((cJob) => {
        if (cJob.conflict === true) {
          return cJob;
        }
        const pending = queue.filter(
          (q) => q.jobId === cJob.id || (q.endpoint && q.endpoint.includes(cJob.id))
        );
        if (pending.length > 0) {
          let merged: Job = {
            ...cJob,
            is_synced: false,
            pending_sync: true,
            syncedAt: null,
          };
          for (const action of pending) {
            if (action.body) {
              merged = {
                ...merged,
                ...action.body,
                status: action.body.status || (action.endpoint.includes('/complete') ? 'COMPLETED' : merged.status),
                is_synced: false,
                pending_sync: true,
                syncedAt: null,
              };
            }
          }
          return merged;
        }
        return cJob;
      });
      return { jobs: mergedCached, fromCache: true };
    }
    throw networkError;
  }
}

/**
 * Alias for getJobs to retrieve work orders assigned to a technician.
 */
export const getAssignedJobs = getJobs;

/**
 * Fetch all active field staff members.
 * Falls back to local storage cache when offline.
 */
export async function getStaffMembers(): Promise<User[]> {
  try {
    const staff = await apiRequest<User[]>('/technicians');
    await saveCachedStaff(staff);
    return staff;
  } catch (networkError) {
    console.warn('Failed to fetch staff from API, checking local cache:', networkError);
    const cached = await getCachedStaff();
    if (cached && cached.length > 0) {
      return cached;
    }
    throw networkError;
  }
}

/**
 * Fetch single job by ID.
 * Returns fresh job or falls back to local cache.
 */
export async function getJobById(id: string): Promise<{ job: Job; fromCache: boolean }> {
  try {
    const freshJob = await apiRequest<Job>(`/jobs/${id}`);
    const [queue, existingCached] = await Promise.all([
      getOfflineSyncQueue(),
      getCachedJobById(id),
    ]);
    if (existingCached?.conflict === true) {
      const conflictedJob: Job = {
        ...existingCached,
        serverConflictState: freshJob,
      };
      await updateCachedJobLocally(id, conflictedJob);
      return { job: conflictedJob, fromCache: false };
    }

    const hasPending = queue.some(
      (q) => q.jobId === id || (q.endpoint && q.endpoint.includes(id))
    );
    const normalizedJob: Job = hasPending
      ? { ...freshJob, is_synced: false, pending_sync: true, syncedAt: null }
      : {
          ...freshJob,
          syncedAt: freshJob.syncedAt || freshJob.updatedAt || new Date().toISOString(),
          is_synced: true,
          pending_sync: false,
          conflict: false,
        };

    if (!normalizedJob.afterPhotoUrl && (existingCached?.afterPhotoUrl || (existingCached as any)?.afterPhoto || (existingCached as any)?.afterPhotoUri)) {
      normalizedJob.afterPhotoUrl = existingCached?.afterPhotoUrl || (existingCached as any)?.afterPhoto || (existingCached as any)?.afterPhotoUri;
    }
    if (!normalizedJob.beforePhotoUrl && (existingCached?.beforePhotoUrl || (existingCached as any)?.beforePhoto || (existingCached as any)?.beforePhotoUri)) {
      normalizedJob.beforePhotoUrl = existingCached?.beforePhotoUrl || (existingCached as any)?.beforePhoto || (existingCached as any)?.beforePhotoUri;
    }

    await updateCachedJobLocally(id, normalizedJob);
    return { job: normalizedJob, fromCache: false };
  } catch (networkError) {
    console.warn(`Network fetch for job ${id} failed, checking cache:`, networkError);
    const cached = await getCachedJobById(id);
    if (cached) {
      return { job: cached, fromCache: true };
    }
    throw networkError;
  }
}

/**
 * Update job fields.
 * Optimistically updates local cache and attempts server update.
 * Upon HTTP 200, marks is_synced = true and pending_sync = false.
 * If offline or network error occurs, enqueues the action into offline sync queue with pending_sync = true
 * and preserves the local record's clientVersion for Optimistic Concurrency Control.
 */
export async function updateJob(
  id: string,
  payload: {
    status?: JobStatus;
    completionNotes?: string | null;
    notes?: string | null;
    signatureData?: string | null;
    signatureSvg?: string | null;
    clientUpdatedAt?: string;
    completedLatitude?: number | null;
    completedLongitude?: number | null;
    latitude?: number | null;
    longitude?: number | null;
    beforePhoto?: string | null;
    beforePhotoUrl?: string | null;
    afterPhoto?: string | null;
    afterPhotoUrl?: string | null;
    materialsUsed?: MaterialUsed[] | string | null;
    laborCost?: number;
    customServices?: any;
    totalAmount?: number;
    paymentStatus?: string;
    paymentMethod?: string | null;
    paymentNotes?: string | null;
  }
): Promise<{ job: Job; queuedOffline: boolean }> {
  const existingCached = await getCachedJobById(id);
  const clientVersion = existingCached?.version ?? 1;
  const clientUpdatedAt = payload.clientUpdatedAt || new Date().toISOString();
  const fullPayload = { ...payload, clientVersion, clientUpdatedAt };

  // Optimistic update in cache first (marked pending_sync: true until HTTP 200 confirms)
  const optimisticState: Partial<Job> = {
    ...fullPayload,
    version: clientVersion,
    syncedAt: null,
    is_synced: false,
    pending_sync: true,
    conflict: false,
    conflictReason: null,
  };
  const optimisticallyUpdated = await updateCachedJobLocally(id, optimisticState);
  notifyJobCacheUpdated(id, optimisticState);

  try {
    const endpoint = payload.status === 'COMPLETED' ? `/jobs/${id}/complete` : `/jobs/${id}`;
    const networkPayload = await resolvePayloadPhotosForUpload(fullPayload);

    const serverUpdated = await apiRequest<Job>(
      endpoint,
      {
        method: 'PATCH',
        body: JSON.stringify(networkPayload),
      },
      25000
    );

    // Ensure syncedAt timestamp is recorded and at least >= clientUpdatedAt, and mark is_synced = true / pending_sync = false
    const nowIso = new Date().toISOString();
    let syncedAt = serverUpdated.syncedAt || nowIso;
    if (new Date(syncedAt).getTime() < new Date(clientUpdatedAt).getTime()) {
      syncedAt = new Date(new Date(clientUpdatedAt).getTime() + 1000).toISOString();
    }

    const finalJob: Job = {
      ...serverUpdated,
      syncedAt,
      is_synced: true,
      pending_sync: false,
      conflict: false,
      conflictReason: null,
      serverConflictState: null,
    };

    // Update local cache with server version and cleared pending_sync flag
    await updateCachedJobLocally(id, finalJob);
    notifyJobCacheUpdated(id, finalJob);
    console.log(`[SyncEngine] Successfully synced job ${id}`);

    return { job: finalJob, queuedOffline: false };
  } catch (networkError) {
    console.warn(`Network update failed for job ${id}, queuing offline sync:`, networkError);
    const endpoint = payload.status === 'COMPLETED' ? `/jobs/${id}/complete` : `/jobs/${id}`;
    const idempotencyKey = generateUUID();
    await enqueueOfflineAction({
      id: `action_${id}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      endpoint,
      method: 'PATCH',
      body: fullPayload,
      timestamp: Date.now(),
      jobId: id,
      clientVersion,
      idempotencyKey,
    });

    const fallbackJob: Job = optimisticallyUpdated || {
      id,
      title: '',
      description: '',
      customerName: '',
      customerPhone: '',
      customerAddress: '',
      priority: 'MEDIUM',
      status: (payload.status as any) || 'PENDING',
      completionNotes: payload.completionNotes || payload.notes,
      signatureData: payload.signatureData || payload.signatureSvg,
      completedLatitude: payload.completedLatitude ?? payload.latitude,
      completedLongitude: payload.completedLongitude ?? payload.longitude,
      beforePhotoUrl: payload.beforePhotoUrl || payload.beforePhoto,
      afterPhotoUrl: payload.afterPhotoUrl || payload.afterPhoto,
      materialsUsed: payload.materialsUsed,
      clientUpdatedAt,
      version: clientVersion,
      syncedAt: null,
      is_synced: false,
      pending_sync: true,
    };

    return { job: fallbackJob, queuedOffline: true };
  }
}

/**
 * Update job status with offline queuing support
 */
export async function updateJobStatus(
  id: string,
  status: JobStatus
): Promise<{ job: Job; queuedOffline: boolean }> {
  return updateJob(id, { status });
}

/**
 * PATCH /api/jobs/:id/location
 * Stream real-time technician GPS coordinates while EN_ROUTE
 */
export async function sendJobLocation(
  jobId: string,
  coords: { latitude: number; longitude: number; timestamp?: number }
): Promise<{ success: boolean; latitude?: number; longitude?: number } | null> {
  try {
    return await apiRequest<{ success: boolean; latitude?: number; longitude?: number }>(
      `/jobs/${jobId}/location`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          latitude: coords.latitude,
          longitude: coords.longitude,
          timestamp: coords.timestamp || Date.now(),
        }),
      }
    );
  } catch (err) {
    console.warn(`Failed to stream live location for job ${jobId}:`, err);
    return null;
  }
}

type QueueDrainListener = () => void;
const drainListeners = new Set<QueueDrainListener>();

/**
 * Register a listener to be notified when the offline queue is drained (pendingCount reaches 0)
 */
export function onQueueDrained(listener: QueueDrainListener): () => void {
  drainListeners.add(listener);
  return () => {
    drainListeners.delete(listener);
  };
}

function notifyQueueDrained() {
  drainListeners.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.warn('Queue drain listener error:', err);
    }
  });
}

type SyncStateListener = (isSyncing: boolean) => void;
const syncStateListeners = new Set<SyncStateListener>();

/**
 * Register a listener to be notified when offline syncing starts or stops
 */
export function onSyncStateChange(listener: SyncStateListener): () => void {
  syncStateListeners.add(listener);
  return () => {
    syncStateListeners.delete(listener);
  };
}

function notifySyncState(isSyncing: boolean) {
  syncStateListeners.forEach((fn) => {
    try {
      fn(isSyncing);
    } catch (err) {
      console.warn('Sync state listener error:', err);
    }
  });
}

type JobCacheListener = (jobId: string, updates: Partial<Job>) => void;
const jobCacheListeners = new Set<JobCacheListener>();

/**
 * Register a listener for optimistic local job updates (e.g. status completed offline)
 */
export function onJobCacheUpdated(listener: JobCacheListener): () => void {
  jobCacheListeners.add(listener);
  return () => {
    jobCacheListeners.delete(listener);
  };
}

export function notifyJobCacheUpdated(jobId: string, updates: Partial<Job>) {
  jobCacheListeners.forEach((fn) => {
    try {
      fn(jobId, updates);
    } catch (err) {
      console.warn('Job cache listener error:', err);
    }
  });
}

let isSyncingQueue = false;
let retryBackoffTimeout: ReturnType<typeof setTimeout> | null = null;

export function getIsSyncing(): boolean {
  return isSyncingQueue;
}

/**
 * Replay all queued offline actions AND any locally unsynced cached jobs in a single
 * atomic batch `POST /api/sync` request with Optimistic Concurrency Control (OCC).
 *
 * - `processed`: removes mutations from `offline_sync_queue`, updates local cached jobs with new `version`,
 *   sets `is_synced: true, pending_sync: false`, and deletes local cached disk photo files.
 * - `serverUpdates`: merges incoming delta records into `jobs_cache` without overwriting jobs that still have pending local edits.
 * - `conflicts`: marks the local job with `conflict: true` so the UI displays a conflict badge rather than silently discarding technician work.
 */
export async function replayOfflineQueue(): Promise<{
  syncedCount: number;
  pendingCount: number;
  errors: any[];
}> {
  if (isSyncingQueue) {
    return { syncedCount: 0, pendingCount: await getPendingSyncCount(), errors: [] };
  }

  isSyncingQueue = true;
  notifySyncState(true);

  try {
    // 1. Check if there are any locally unsynced jobs in jobs_cache that aren't in offline_sync_queue
    const currentQueue = await getOfflineSyncQueue();
    const cachedJobs = await getCachedJobs();
    for (const cachedJob of cachedJobs) {
      if (isJobLocallyUnsynced(cachedJob)) {
        const alreadyQueued = currentQueue.some(
          (q) => q.jobId === cachedJob.id || (q.endpoint && q.endpoint.includes(cachedJob.id))
        );
        if (!alreadyQueued) {
          const isComplete = cachedJob.status === 'COMPLETED';
          const endpoint = isComplete ? `/jobs/${cachedJob.id}/complete` : `/jobs/${cachedJob.id}`;
          const idempotencyKey = generateUUID();
          await enqueueOfflineAction({
            id: `recover_${cachedJob.id}_${Date.now()}`,
            endpoint,
            method: 'PATCH',
            body: {
              status: cachedJob.status,
              completionNotes: cachedJob.completionNotes,
              signatureData: cachedJob.signatureData,
              completedLatitude: cachedJob.completedLatitude,
              completedLongitude: cachedJob.completedLongitude,
              beforePhotoUrl: cachedJob.beforePhotoUrl,
              afterPhotoUrl: cachedJob.afterPhotoUrl,
              materialsUsed: cachedJob.materialsUsed,
              clientUpdatedAt: cachedJob.clientUpdatedAt || new Date().toISOString(),
            },
            timestamp: Date.now(),
            jobId: cachedJob.id,
            clientVersion: cachedJob.version ?? 1,
            idempotencyKey,
          });
        }
      }
    }

    // 2. Collect all queued mutations and send them in a single atomic POST /api/sync request
    const queue = await getOfflineSyncQueue();
    if (queue.length === 0) {
      if (retryBackoffTimeout) {
        clearTimeout(retryBackoffTimeout);
        retryBackoffTimeout = null;
      }
      return { syncedCount: 0, pendingCount: 0, errors: [] };
    }

    const latestCachedJobs = await getCachedJobs();
    const cachedJobMap = new Map<string, Job>(latestCachedJobs.map((j) => [j.id, j]));

    const mutations: SyncMutation[] = [];
    const actionIdsByJobId = new Map<string, string[]>();

    // Group actions by jobId to coalesce and deduplicate multiple offline operations for the same job
    const actionsByJobId = new Map<string, QueuedAction[]>();
    for (const action of queue) {
      const jobId = resolveActionJobId(action.endpoint, action.jobId);
      if (!jobId) {
        await removeFromOfflineQueue(action.id);
        continue;
      }
      const list = actionsByJobId.get(jobId) || [];
      list.push(action);
      actionsByJobId.set(jobId, list);
    }

    for (const [jobId, jobActions] of actionsByJobId.entries()) {
      // Sort chronologically by timestamp
      jobActions.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      const cachedJob = cachedJobMap.get(jobId);
      const actionIds = jobActions.map((a) => a.id);
      actionIdsByJobId.set(jobId, actionIds);

      // Merge and coalesce all actions for this jobId in chronological order
      let mergedData: Record<string, any> = {};
      let isCompleted = false;
      let isLocationOnly = true;
      let latestClientUpdatedAt = new Date(jobActions[0].timestamp || Date.now()).toISOString();
      let idempotencyKey = '';

      for (const action of jobActions) {
        if (action.endpoint?.includes('/complete') || action.body?.status === 'COMPLETED') {
          isCompleted = true;
          isLocationOnly = false;
        } else if (!action.endpoint?.includes('/location')) {
          isLocationOnly = false;
        }

        const resolved = await resolvePayloadPhotosForUpload(action.body || {});
        mergedData = {
          ...mergedData,
          ...resolved,
        };

        if (resolved?.clientUpdatedAt) {
          latestClientUpdatedAt = resolved.clientUpdatedAt;
        } else if (action.timestamp) {
          latestClientUpdatedAt = new Date(action.timestamp).toISOString();
        }

        if (action.idempotencyKey) {
          idempotencyKey = action.idempotencyKey;
        }
      }

      // If any action completed the job or cache is COMPLETED, ensure a unified COMPLETED mutation with all artifacts
      if (isCompleted || cachedJob?.status === 'COMPLETED' || mergedData.status === 'COMPLETED') {
        mergedData.status = 'COMPLETED';

        // Preserve all completion artifacts from cache or actions
        if (!mergedData.completionNotes && cachedJob?.completionNotes) {
          mergedData.completionNotes = cachedJob.completionNotes;
        }
        if (!mergedData.notes && (cachedJob?.completionNotes || (cachedJob as any)?.notes)) {
          mergedData.notes = cachedJob?.completionNotes || (cachedJob as any)?.notes;
        }
        if (!mergedData.signatureData && cachedJob?.signatureData) {
          mergedData.signatureData = cachedJob.signatureData;
        }
        if (!mergedData.signatureSvg && cachedJob?.signatureSvg) {
          mergedData.signatureSvg = cachedJob.signatureSvg;
        }
        if (!mergedData.beforePhotoUrl && (cachedJob?.beforePhotoUrl || (cachedJob as any)?.beforePhoto)) {
          mergedData.beforePhotoUrl = cachedJob?.beforePhotoUrl || (cachedJob as any)?.beforePhoto;
        }
        if (!mergedData.afterPhotoUrl && (cachedJob?.afterPhotoUrl || (cachedJob as any)?.afterPhoto)) {
          mergedData.afterPhotoUrl = cachedJob?.afterPhotoUrl || (cachedJob as any)?.afterPhoto;
        }
        if (!mergedData.materialsUsed && cachedJob?.materialsUsed) {
          mergedData.materialsUsed = cachedJob.materialsUsed;
        }
        if (mergedData.completedLatitude === undefined && cachedJob?.completedLatitude !== undefined) {
          mergedData.completedLatitude = cachedJob.completedLatitude;
        }
        if (mergedData.completedLongitude === undefined && cachedJob?.completedLongitude !== undefined) {
          mergedData.completedLongitude = cachedJob.completedLongitude;
        }
        if (!mergedData.customerEmail && cachedJob?.customerEmail) {
          mergedData.customerEmail = cachedJob.customerEmail;
        }
      }

      let mutationType: SyncMutationType = 'STATUS_UPDATE';
      if (isCompleted || mergedData.status === 'COMPLETED') {
        mutationType = 'COMPLETE_JOB';
      } else if (isLocationOnly) {
        mutationType = 'LOCATION_UPDATE';
      }

      if (!idempotencyKey) {
        idempotencyKey = generateUUID();
      }

      // Base clientVersion: earliest clientVersion from the queued actions or cachedJob.version
      const clientVersion =
        typeof jobActions[0].clientVersion === 'number' && !Number.isNaN(jobActions[0].clientVersion)
          ? jobActions[0].clientVersion
          : cachedJob?.version ?? 1;

      mutations.push({
        jobId,
        type: mutationType,
        clientVersion,
        clientUpdatedAt: latestClientUpdatedAt,
        data: mergedData,
        idempotencyKey,
      });
    }

    if (mutations.length === 0) {
      return { syncedCount: 0, pendingCount: 0, errors: [] };
    }

    const lastSyncRaw = await getLastSyncTimestamp();
    const lastSyncTimestamp = lastSyncRaw ? new Date(lastSyncRaw).toISOString() : null;
    let syncedCount = 0;
    const errors: any[] = [];

    try {
      const response = await fetchWithBaseUrlFallback(
        '/sync',
        {
          method: 'POST',
          body: JSON.stringify({
            lastSyncTimestamp,
            mutations,
          }),
        },
        35000
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Batch Sync HTTP ${response.status}: ${errorText}`);
      }

      const syncResult: SyncResponsePayload = await response.json();

      // 3a. Process `processed` mutations
      if (Array.isArray(syncResult.processed)) {
        for (const item of syncResult.processed) {
          const actionIds = actionIdsByJobId.get(item.jobId) || [];
          for (const actionId of actionIds) {
            await removeFromOfflineQueue(actionId);
          }

          const cachedJob = cachedJobMap.get(item.jobId);
          const clientUpdated = cachedJob?.clientUpdatedAt;
          let syncedAt = item.syncedAt || new Date().toISOString();
          if (clientUpdated && new Date(syncedAt).getTime() < new Date(clientUpdated).getTime()) {
            syncedAt = new Date(new Date(clientUpdated).getTime() + 1000).toISOString();
          }

          const syncedJobUpdate: Partial<Job> = {
            ...(item.job || {}),
            version: item.newVersion,
            syncedAt,
            is_synced: true,
            pending_sync: false,
            conflict: false,
            conflictReason: null,
            serverConflictState: null,
          };

          await updateCachedJobLocally(item.jobId, syncedJobUpdate);
          await cleanupSyncedJobPhotos(item.jobId, [
            cachedJob?.beforePhotoUrl,
            cachedJob?.afterPhotoUrl,
          ]);
          notifyJobCacheUpdated(item.jobId, syncedJobUpdate);
          syncedCount++;
          console.log(`[SyncEngine] Successfully synced job ${item.jobId} (v${item.newVersion})`);
        }

        // On successful sync: clear any active conflict flag from the local cached jobs in jobs_cache
        const processedSet = new Set(syncResult.processed.map((p) => p.jobId));
        const conflictSet = new Set((syncResult.conflicts || []).map((c) => c.jobId));
        const currentCachedJobs = await getCachedJobs();
        let cacheDirty = false;
        const cleanedJobs = currentCachedJobs.map((j) => {
          if (processedSet.has(j.id) && !conflictSet.has(j.id)) {
            if (j.conflict === true || j.conflictReason || j.serverConflictState) {
              cacheDirty = true;
              return {
                ...j,
                conflict: false,
                conflictReason: null,
                serverConflictState: null,
              };
            }
          }
          return j;
        });
        if (cacheDirty) {
          await saveCachedJobs(cleanedJobs);
        }
      }

      // 3b. Process `conflicts` (409 Optimistic Concurrency Control version mismatch)
      if (Array.isArray(syncResult.conflicts)) {
        for (const conflict of syncResult.conflicts) {
          const actionIds = actionIdsByJobId.get(conflict.jobId) || [];
          for (const actionId of actionIds) {
            await removeFromOfflineQueue(actionId);
          }

          const conflictUpdate: Partial<Job> = {
            conflict: true,
            conflictReason: conflict.reason || 'VERSION_MISMATCH',
            serverConflictState: conflict.serverState || null,
            pending_sync: false,
            is_synced: false,
          };

          await updateCachedJobLocally(conflict.jobId, conflictUpdate);
          notifyJobCacheUpdated(conflict.jobId, conflictUpdate);
          console.warn(
            `[SyncEngine] 409 Conflict for job ${conflict.jobId}: ${conflict.reason}`
          );
        }
      }

      // 3c. Process `serverUpdates` (Delta Pull) without overwriting jobs with pending local edits
      if (Array.isArray(syncResult.serverUpdates) && syncResult.serverUpdates.length > 0) {
        const [remainingQueue, currentCachedJobs] = await Promise.all([
          getOfflineSyncQueue(),
          getCachedJobs(),
        ]);
        const currentCacheMap = new Map<string, Job>(currentCachedJobs.map((j) => [j.id, j]));
        let cacheModified = false;

        for (const deltaJob of syncResult.serverUpdates) {
          const localJob = currentCacheMap.get(deltaJob.id);
          const hasPendingQueueItem = remainingQueue.some(
            (q) => q.jobId === deltaJob.id || (q.endpoint && q.endpoint.includes(deltaJob.id))
          );
          const hasLocalPendingEdits =
            hasPendingQueueItem ||
            localJob?.pending_sync === true ||
            localJob?.conflict === true;

          if (!hasLocalPendingEdits) {
            const mergedDelta: Job = {
              ...(localJob || {}),
              ...deltaJob,
              syncedAt: deltaJob.syncedAt || deltaJob.updatedAt || new Date().toISOString(),
              is_synced: true,
              pending_sync: false,
              conflict: false,
            };
            currentCacheMap.set(deltaJob.id, mergedDelta);
            notifyJobCacheUpdated(deltaJob.id, mergedDelta);
            cacheModified = true;
          }
        }

        if (cacheModified) {
          await saveCachedJobs(Array.from(currentCacheMap.values()));
        }
      }
    } catch (batchErr: any) {
      console.warn('[SyncEngine] Batch sync request failed:', batchErr?.message || batchErr);
      errors.push({
        error: batchErr?.message || String(batchErr),
      });
    }

    const pendingCount = await getPendingSyncCount();
    const result = {
      syncedCount,
      pendingCount,
      errors,
    };

    if (result.syncedCount > 0 && result.pendingCount === 0) {
      if (retryBackoffTimeout) {
        clearTimeout(retryBackoffTimeout);
        retryBackoffTimeout = null;
      }
      notifyQueueDrained();
    } else if (result.pendingCount === 0) {
      if (retryBackoffTimeout) {
        clearTimeout(retryBackoffTimeout);
        retryBackoffTimeout = null;
      }
    } else if (result.errors.length > 0 && result.pendingCount > 0) {
      // Failed actions are kept in the queue; schedule retry after backoff delay
      if (retryBackoffTimeout) {
        clearTimeout(retryBackoffTimeout);
      }
      retryBackoffTimeout = setTimeout(() => {
        replayOfflineQueue().catch((err) => {
          console.warn('Backoff retry error:', err);
        });
      }, 4000);
    }

    return result;
  } finally {
    isSyncingQueue = false;
    notifySyncState(false);
  }
}

/**
 * Explicit manual trigger to synchronize pending offline actions to the backend
 */
export async function syncOfflineData(): Promise<{
  syncedCount: number;
  pendingCount: number;
  errors: any[];
}> {
  return replayOfflineQueue();
}

/**
 * Backward compatibility alias for syncOfflineData
 */
export const syncOfflineQueue = syncOfflineData;

/**
 * Initialize automatic background synchronization on network reconnection
 * - Waits until state.isConnected is true
 * - Adds a short delay (1000ms - 1500ms) before calling flush/replay to allow local Wi-Fi handshake to finish
 */
let netInfoUnsub: (() => void) | null = null;
let wifiHandshakeTimeout: ReturnType<typeof setTimeout> | null = null;

export function initNetworkAutoSync(onDrain?: QueueDrainListener): () => void {

  if (onDrain) {
    onQueueDrained(onDrain);
  }

  if (netInfoUnsub) {
    return netInfoUnsub;
  }

  try {
    const NetInfo = require('@react-native-community/netinfo').default;
    netInfoUnsub = NetInfo.addEventListener((state: any) => {
      // 1. Wait until state.isConnected is true
      if (state.isConnected) {
        if (wifiHandshakeTimeout) {
          clearTimeout(wifiHandshakeTimeout);
        }
        // 2. Add short delay (1200ms) before calling flushOfflineQueue to allow local Wi-Fi handshake to finish
        wifiHandshakeTimeout = setTimeout(() => {
          syncOfflineData().catch((err) => {
            console.warn('Auto-sync background replay error:', err);
          });
        }, 1200);
      } else {
        // Disconnected: cancel any pending handshake triggers
        if (wifiHandshakeTimeout) {
          clearTimeout(wifiHandshakeTimeout);
          wifiHandshakeTimeout = null;
        }
      }
    });
  } catch (err) {
    console.warn('Failed to attach NetInfo listener:', err);
  }

  return () => {
    if (netInfoUnsub) {
      netInfoUnsub();
      netInfoUnsub = null;
    }
    if (wifiHandshakeTimeout) {
      clearTimeout(wifiHandshakeTimeout);
      wifiHandshakeTimeout = null;
    }
  };
}

/**
 * Get count of pending offline sync items (including any unsynced cached jobs)
 */
export async function getPendingSyncCount(): Promise<number> {
  const [queue, cachedJobs] = await Promise.all([
    getOfflineSyncQueue(),
    getCachedJobs(),
  ]);
  const queuedIds = new Set(queue.map((q) => q.jobId).filter(Boolean));
  const extraUnsynced = cachedJobs.filter(
    (j) => isJobLocallyUnsynced(j) && !queuedIds.has(j.id)
  ).length;
  return queue.length + extraUnsynced;
}

/**
 * Sample truck inventory seed fallback items for offline resilience
 */
export const DEFAULT_INVENTORY_ITEMS: InventoryItem[] = [
  {
    id: 'inv-cap-45-5',
    name: 'Dual Run Capacitor 45/5 uF',
    sku: 'CAP-455-UF',
    unitCost: 18.0,
    stockQty: 14,
    category: 'Electrical & Capacitors',
  },
  {
    id: 'inv-flt-16-25-1',
    name: 'Pleated Air Filter 16x25x1',
    sku: 'FLT-16251',
    unitCost: 12.5,
    stockQty: 25,
    category: 'Filters & Air Quality',
  },
  {
    id: 'inv-cnt-2p-30a',
    name: 'Contactor 2-Pole 30A',
    sku: 'CNT-2P-30A',
    unitCost: 24.0,
    stockQty: 8,
    category: 'Relays & Contactors',
  },
  {
    id: 'inv-ref-r410a',
    name: 'R-410A Refrigerant (1 lb)',
    sku: 'REF-R410A-1LB',
    unitCost: 35.0,
    stockQty: 30,
    category: 'Refrigerants & Chemicals',
  },
];

/**
 * Fetch available truck inventory items
 * GET /api/inventory
 */
export async function getInventory(): Promise<InventoryItem[]> {
  try {
    const netState = await NetInfo.fetch();
    if (netState.isConnected === false) {
      return DEFAULT_INVENTORY_ITEMS;
    }
    const items = await apiRequest<any[]>('/inventory');
    if (Array.isArray(items) && items.length > 0) {
      return items.map((i: any) => ({
        id: i.id,
        name: i.name,
        sku: i.sku,
        unitCost: Number(i.unitCost || 0),
        stockQty: typeof i.stockQty === 'number' ? i.stockQty : (typeof i.quantityInStock === 'number' ? i.quantityInStock : 0),
        quantityInStock: typeof i.quantityInStock === 'number' ? i.quantityInStock : (typeof i.stockQty === 'number' ? i.stockQty : 0),
        category: i.category || 'Truck Stock',
      }));
    }
    return DEFAULT_INVENTORY_ITEMS;
  } catch (err) {
    console.warn('Failed to fetch inventory from server, using local fallback:', err);
    return DEFAULT_INVENTORY_ITEMS;
  }
}

/**
 * POST /api/jobs/:id/materials
 * Add parts used to a job and deduct truck inventory
 */
export async function addJobMaterials(
  jobId: string,
  items: Array<{ itemId: string; quantity: number }>
): Promise<any> {
  return await apiRequest(`/jobs/${jobId}/materials`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

export interface SystemSettings {
  baseLaborFee: number;
  defaultBaseLaborFee: number;
}

/**
 * Fetch dynamic system settings (e.g. defaultBaseLaborFee)
 * GET /api/dispatcher/settings
 */
export async function getSystemSettings(): Promise<SystemSettings> {
  try {
    const res = await apiRequest<any>('/dispatcher/settings');
    const fee =
      typeof res?.defaultBaseLaborFee === 'number'
        ? res.defaultBaseLaborFee
        : typeof res?.baseLaborFee === 'number'
        ? res.baseLaborFee
        : 50.0;
    return {
      baseLaborFee: fee,
      defaultBaseLaborFee: fee,
    };
  } catch (err) {
    console.warn('Failed to fetch system settings from server, using fallback:', err);
    return {
      baseLaborFee: 50.0,
      defaultBaseLaborFee: 50.0,
    };
  }
}

/**
 * Connect the mobile client to the backend SSE stream (GET /api/events or /api/dispatcher/events).
 * Listens for real-time JOB_ASSIGNED, JOB_UPDATED, and INVENTORY_UPDATED notifications.
 */
export function subscribeToRealtimeEvents(
  onEvent: (eventType: string, data: any) => void
): () => void {
  let isClosed = false;
  let xhr: XMLHttpRequest | null = null;
  let es: any = null;
  let reconnectTimeout: any = null;

  const url = `${getApiBaseUrl()}/events`;

  const connect = () => {
    if (isClosed) return;

    if (typeof EventSource !== 'undefined') {
      try {
        es = new EventSource(url);
        es.onmessage = (e: any) => {
          try {
            onEvent('message', JSON.parse(e.data));
          } catch {}
        };
        es.addEventListener('JOB_ASSIGNED', (e: any) => {
          try {
            onEvent('JOB_ASSIGNED', JSON.parse(e.data));
          } catch {}
        });
        es.addEventListener('NEW_JOB', (e: any) => {
          try {
            onEvent('NEW_JOB', JSON.parse(e.data));
          } catch {}
        });
        es.addEventListener('JOB_CREATED', (e: any) => {
          try {
            onEvent('JOB_CREATED', JSON.parse(e.data));
          } catch {}
        });
        es.addEventListener('JOB_UPDATED', (e: any) => {
          try {
            onEvent('JOB_UPDATED', JSON.parse(e.data));
          } catch {}
        });
        es.addEventListener('JOB_REASSIGNED', (e: any) => {
          try {
            onEvent('JOB_REASSIGNED', JSON.parse(e.data));
          } catch {}
        });
        es.addEventListener('INVENTORY_UPDATED', (e: any) => {
          try {
            onEvent('INVENTORY_UPDATED', JSON.parse(e.data));
          } catch {}
        });
        es.addEventListener('STAFF_REMOVED', (e: any) => {
          try {
            onEvent('STAFF_REMOVED', JSON.parse(e.data));
          } catch {}
        });
        es.onerror = () => {
          es?.close();
          if (!isClosed) {
            reconnectTimeout = setTimeout(connect, 5000);
          }
        };
        return;
      } catch (err) {
        console.warn('EventSource failed, falling back to streaming XHR:', err);
      }
    }

    // Fallback using streaming XMLHttpRequest (compatible with native React Native runtimes)
    try {
      xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Accept', 'text/event-stream');
      xhr.setRequestHeader('Cache-Control', 'no-cache');

      let processedIndex = 0;

      xhr.onprogress = () => {
        if (isClosed) return;
        const text = xhr?.responseText || '';
        const newChunk = text.substring(processedIndex);
        processedIndex = text.length;

        const lines = newChunk.split(/\r?\n/);
        let currentEvent = 'message';
        let currentData = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.substring(6).trim();
          } else if (line.startsWith('data:')) {
            currentData = line.substring(5).trim();
          } else if (line === '' && currentData) {
            try {
              const parsed = JSON.parse(currentData);
              onEvent(currentEvent, parsed);
            } catch (parseErr) {}
            currentEvent = 'message';
            currentData = '';
          }
        }

        // Prevent perpetual memory leak: if responseText exceeds 500KB (500,000 chars),
        // cleanly abort and reconnect so native heap is reclaimed
        if (text.length > 500000) {
          processedIndex = 0;
          try {
            xhr?.abort();
          } catch {}
          if (!isClosed) {
            reconnectTimeout = setTimeout(connect, 500);
          }
        }
      };

      xhr.onerror = () => {
        if (!isClosed) {
          reconnectTimeout = setTimeout(connect, 5000);
        }
      };

      xhr.onloadend = () => {
        if (!isClosed) {
          reconnectTimeout = setTimeout(connect, 5000);
        }
      };

      xhr.send();
    } catch (err) {
      if (!isClosed) {
        reconnectTimeout = setTimeout(connect, 5000);
      }
    }
  };

  connect();

  return () => {
    isClosed = true;
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (es) {
      try {
        es.close();
      } catch {}
    }
    if (xhr) {
      try {
        xhr.abort();
      } catch {}
    }
  };
}