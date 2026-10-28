import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ExpoFileSystem from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { Job, QueuedAction, User } from '../types';

const FileSystem = {
  ...ExpoFileSystem,
  ...LegacyFileSystem,
};

export const PHOTOS_DIR = `${FileSystem.documentDirectory}fieldops_photos/`;

/**
 * Ensure the dedicated fieldops_photos directory exists on local disk.
 */
async function ensurePhotosDirExists(): Promise<void> {
  try {
    const dirInfo = await FileSystem.getInfoAsync(PHOTOS_DIR);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(PHOTOS_DIR, { intermediates: true });
    }
  } catch (err) {
    console.warn('Failed to ensure fieldops_photos directory exists:', err);
  }
}

/**
 * Save a base64 photo string or temporary cache URI to durable local disk storage
 * under `${FileSystem.documentDirectory}fieldops_photos/` and return its permanent `file:///...` URI.
 */
export async function savePhotoToLocalDisk(
  photoBase64OrUri: string,
  filename: string
): Promise<string> {
  if (!photoBase64OrUri || typeof photoBase64OrUri !== 'string') {
    return '';
  }

  // If already persisted in PHOTOS_DIR or is a remote HTTP(S) URL, return directly
  if (
    photoBase64OrUri.startsWith(PHOTOS_DIR) ||
    photoBase64OrUri.startsWith('http://') ||
    photoBase64OrUri.startsWith('https://')
  ) {
    return photoBase64OrUri;
  }

  await ensurePhotosDirExists();

  const sanitizedName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const finalFilename =
    sanitizedName.endsWith('.jpg') ||
    sanitizedName.endsWith('.jpeg') ||
    sanitizedName.endsWith('.png')
      ? sanitizedName
      : `${sanitizedName}.jpg`;
  const targetUri = `${PHOTOS_DIR}${finalFilename}`;

  try {
    if (
      photoBase64OrUri.startsWith('data:image/') ||
      (!photoBase64OrUri.startsWith('file://') && !photoBase64OrUri.startsWith('content://'))
    ) {
      const base64Data = photoBase64OrUri.includes(';base64,')
        ? photoBase64OrUri.split(';base64,')[1]
        : photoBase64OrUri;

      await FileSystem.writeAsStringAsync(targetUri, base64Data, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return targetUri;
    }

    // Input is a temporary cache file:// or content:// URI: copy into durable PHOTOS_DIR
    await FileSystem.copyAsync({
      from: photoBase64OrUri,
      to: targetUri,
    });
    return targetUri;
  } catch (err) {
    console.warn(`Failed to save photo ${finalFilename} to local disk:`, err);
    return photoBase64OrUri;
  }
}

/**
 * Delete cached local disk photos for a job once it has successfully synchronized with the server.
 */
export async function cleanupSyncedJobPhotos(
  jobId: string,
  explicitUris?: Array<string | null | undefined>
): Promise<void> {
  try {
    // Purge individual AsyncStorage keys to prevent SQLite row bloat
    await AsyncStorage.multiRemove([
      `@fieldops_photo_${jobId}_before`,
      `@fieldops_photo_${jobId}_after`,
      `@fieldops_sig_${jobId}`,
    ]).catch(() => {});

    if (explicitUris && explicitUris.length > 0) {
      for (const uri of explicitUris) {
        if (uri && typeof uri === 'string' && uri.startsWith(PHOTOS_DIR)) {
          await FileSystem.deleteAsync(uri, { idempotent: true });
        }
      }
    }

    const dirInfo = await FileSystem.getInfoAsync(PHOTOS_DIR);
    if (!dirInfo.exists) return;

    const safeJobPrefix = `job_${jobId.replace(/[^a-zA-Z0-9._-]/g, '_')}_`;
    const files = await FileSystem.readDirectoryAsync(PHOTOS_DIR);
    for (const file of files) {
      if (file.startsWith(safeJobPrefix)) {
        await FileSystem.deleteAsync(`${PHOTOS_DIR}${file}`, { idempotent: true });
      }
    }
  } catch (err) {
    console.warn(`Failed to cleanup synced disk photos for job ${jobId}:`, err);
  }
}

const STORAGE_KEYS = {
  JOBS_CACHE: 'jobs_cache',
  LEGACY_JOBS_CACHE: '@fieldops_jobs_cache',
  SYNC_QUEUE: 'offline_sync_queue',
  LEGACY_SYNC_QUEUE: '@fieldops_offline_sync_queue',
  LAST_SYNC: '@fieldops_last_sync_timestamp',
  AUTH_TOKEN: 'token',
  LEGACY_AUTH_TOKEN: '@fieldops_auth_token',
  AUTH_USER: 'user',
  LEGACY_AUTH_USER: '@fieldops_auth_user',
  ACTIVE_STAFF_ID: 'activeStaffId',
  ACTIVE_STAFF_DATA: '@fieldops_active_staff_data',
  STAFF_CACHE: '@fieldops_staff_cache',
};

/**
 * Retrieve stored JWT authentication token
 */
export async function getAuthToken(): Promise<string | null> {
  try {
    const token = await AsyncStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    if (token) return token;
    return await AsyncStorage.getItem(STORAGE_KEYS.LEGACY_AUTH_TOKEN);
  } catch (error) {
    console.warn('Failed to read auth token from AsyncStorage:', error);
    return null;
  }
}

/**
 * Retrieve stored authenticated technician user profile
 */
export async function getAuthUser(): Promise<User | null> {
  try {
    const raw =
      (await AsyncStorage.getItem(STORAGE_KEYS.AUTH_USER)) ||
      (await AsyncStorage.getItem(STORAGE_KEYS.LEGACY_AUTH_USER)) ||
      (await AsyncStorage.getItem(STORAGE_KEYS.ACTIVE_STAFF_DATA));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    console.warn('Failed to read authenticated user from AsyncStorage:', error);
    return null;
  }
}

/**
 * Persist JWT token and authenticated user profile to AsyncStorage
 */
export async function saveAuthSession(token: string, user: User): Promise<void> {
  try {
    await Promise.all([
      AsyncStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, token),
      AsyncStorage.setItem(STORAGE_KEYS.LEGACY_AUTH_TOKEN, token),
      AsyncStorage.setItem(STORAGE_KEYS.AUTH_USER, JSON.stringify(user)),
      AsyncStorage.setItem(STORAGE_KEYS.LEGACY_AUTH_USER, JSON.stringify(user)),
      AsyncStorage.setItem(STORAGE_KEYS.ACTIVE_STAFF_ID, user.id),
      AsyncStorage.setItem(STORAGE_KEYS.ACTIVE_STAFF_DATA, JSON.stringify(user)),
    ]);
  } catch (error) {
    console.warn('Failed to persist auth session to AsyncStorage:', error);
  }
}

/**
 * Clear JWT token, authenticated user profile, and all session artifacts on Sign Out
 */
export async function clearAuthSession(): Promise<void> {
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
      STORAGE_KEYS.AUTH_TOKEN,
      STORAGE_KEYS.LEGACY_AUTH_TOKEN,
      STORAGE_KEYS.AUTH_USER,
      STORAGE_KEYS.LEGACY_AUTH_USER,
      STORAGE_KEYS.ACTIVE_STAFF_ID,
      STORAGE_KEYS.ACTIVE_STAFF_DATA,
      STORAGE_KEYS.JOBS_CACHE,
      STORAGE_KEYS.LEGACY_JOBS_CACHE,
      STORAGE_KEYS.SYNC_QUEUE,
      STORAGE_KEYS.LEGACY_SYNC_QUEUE,
      'has_prompted_gps',
    ]);
    await AsyncStorage.removeItem('has_prompted_gps');
  } catch (error) {
    console.warn('Failed to clear auth session from AsyncStorage:', error);
  }
}

/**
 * Retrieve active staff ID
 */
export async function getActiveStaffId(): Promise<string | null> {
  try {
    const user = await getAuthUser();
    if (user?.id) return user.id;
    return await AsyncStorage.getItem(STORAGE_KEYS.ACTIVE_STAFF_ID);
  } catch (error) {
    console.warn('Failed to read activeStaffId from AsyncStorage:', error);
    return null;
  }
}

/**
 * Save active staff ID
 */
export async function setActiveStaffId(id: string): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEYS.ACTIVE_STAFF_ID, id);
  } catch (error) {
    console.warn('Failed to persist activeStaffId into AsyncStorage:', error);
  }
}

/**
 * Clear active staff ID
 */
export async function clearActiveStaffId(): Promise<void> {
  await clearAuthSession();
}

/**
 * Retrieve active staff profile data
 */
export async function getActiveStaffData(): Promise<User | null> {
  return getAuthUser();
}

/**
 * Save active staff profile data
 */
export async function setActiveStaffData(user: User): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEYS.AUTH_USER, JSON.stringify(user));
    await AsyncStorage.setItem(STORAGE_KEYS.ACTIVE_STAFF_DATA, JSON.stringify(user));
    await AsyncStorage.setItem(STORAGE_KEYS.ACTIVE_STAFF_ID, user.id);
  } catch (error) {
    console.warn('Failed to persist active staff data:', error);
  }
}

/**
 * Save staff roster cache for offline profile switching
 */
export async function saveCachedStaff(staff: User[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEYS.STAFF_CACHE, JSON.stringify(staff));
  } catch (error) {
    console.warn('Failed to cache staff roster:', error);
  }
}

/**
 * Retrieve cached staff roster
 */
export async function getCachedStaff(): Promise<User[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.STAFF_CACHE);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (error) {
    console.warn('Failed to read cached staff roster:', error);
    return [];
  }
}

/**
 * Permanently clear any existing corrupted cache items on app start
 */
export async function clearCorruptedCacheOnAppStart(): Promise<void> {
  try {
    const alreadyPurged = await AsyncStorage.getItem('@fieldops_purged_corrupted_v2');
    if (!alreadyPurged) {
      await AsyncStorage.removeItem('jobs_cache');
      await AsyncStorage.removeItem('offline_sync_queue');
      await AsyncStorage.removeItem(STORAGE_KEYS.LEGACY_JOBS_CACHE);
      await AsyncStorage.removeItem(STORAGE_KEYS.LEGACY_SYNC_QUEUE);
      await AsyncStorage.setItem('@fieldops_purged_corrupted_v2', 'true');
    }
  } catch (err) {
    console.warn('Failed to clear corrupted cache on app start:', err);
  }
}

/**
 * Retrieve cached jobs from persistent storage, optionally filtered by staff ID
 */
export async function getCachedJobs(assignedTechId?: string): Promise<Job[]> {
  try {
    let raw = await AsyncStorage.getItem(STORAGE_KEYS.JOBS_CACHE);
    if (!raw) {
      raw = await AsyncStorage.getItem(STORAGE_KEYS.LEGACY_JOBS_CACHE);
    }
    if (!raw) return [];
    const allJobs: Job[] = JSON.parse(raw);
    if (assignedTechId) {
      return allJobs.filter(
        (j) => j.technicianId === assignedTechId || j.technician?.id === assignedTechId
      );
    }
    return allJobs;
  } catch (error: any) {
    const errorMsg = String(error?.message || error || '');
    if (errorMsg.includes('CursorWindow') || errorMsg.includes('Row too big')) {
      console.warn('Row too big to fit into CursorWindow! Purging corrupted jobs cache.');
      await AsyncStorage.removeItem(STORAGE_KEYS.JOBS_CACHE).catch(() => {});
      await AsyncStorage.removeItem(STORAGE_KEYS.LEGACY_JOBS_CACHE).catch(() => {});
      return [];
    }
    console.warn('Failed to read cached jobs from AsyncStorage:', error);
    return [];
  }
}

/**
 * Save jobs list into persistent storage (merging if scoped to a specific technician).
 * Converts any inline base64 photos to permanent file:/// URIs on disk so AsyncStorage
 * remains lightweight while preserving photo references across app restarts.
 */
export async function saveCachedJobs(jobs: Job[], assignedTechId?: string): Promise<void> {
  try {
    let toSave: Job[] = jobs;
    if (assignedTechId) {
      const existing = await getCachedJobs();
      const others = existing.filter(
        (j) => j.technicianId !== assignedTechId && j.technician?.id !== assignedTechId
      );
      toSave = [...jobs, ...others];
    }

    const sanitized = await Promise.all(
      toSave.map(async (job) => {
        const isUnsynced = job.pending_sync === true || job.is_synced === false;
        const rawBefore = job.beforePhotoUrl || job.beforePhoto || null;
        const rawAfter = job.afterPhotoUrl || job.afterPhoto || null;
        const rawSig = job.signatureData || job.signatureSvg || null;

        let beforePhotoUrl: string | null = null;
        let afterPhotoUrl: string | null = null;

        if (rawBefore) {
          if (rawBefore.startsWith('data:')) {
            // Save full raw base64 in separate per-job storage key to protect jobs_cache row limit
            await AsyncStorage.setItem(`@fieldops_photo_${job.id}_before`, rawBefore).catch(() => {});
            const diskUri = await savePhotoToLocalDisk(
              rawBefore,
              `job_${job.id}_before.jpg`
            );
            beforePhotoUrl = diskUri && !diskUri.startsWith('data:') ? diskUri : `@fieldops_photo_${job.id}_before`;
          } else {
            beforePhotoUrl = rawBefore;
          }
        }

        if (rawAfter) {
          if (rawAfter.startsWith('data:')) {
            // Save full raw base64 in separate per-job storage key to protect jobs_cache row limit
            await AsyncStorage.setItem(`@fieldops_photo_${job.id}_after`, rawAfter).catch(() => {});
            const diskUri = await savePhotoToLocalDisk(
              rawAfter,
              `job_${job.id}_after.jpg`
            );
            afterPhotoUrl = diskUri && !diskUri.startsWith('data:') ? diskUri : `@fieldops_photo_${job.id}_after`;
          } else {
            afterPhotoUrl = rawAfter;
          }
        }

        let signatureDataRef: string | null = null;
        if (rawSig) {
          if (rawSig.startsWith('data:') || rawSig.length > 256) {
            await AsyncStorage.setItem(`@fieldops_sig_${job.id}`, rawSig).catch(() => {});
            signatureDataRef = isUnsynced ? `@fieldops_sig_${job.id}` : null;
          } else {
            signatureDataRef = isUnsynced ? rawSig : null;
          }
        }

        return {
          ...job,
          beforePhoto: undefined,
          beforePhotoUrl,
          afterPhoto: undefined,
          afterPhotoUrl,
          signatureSvg: undefined,
          signatureData: signatureDataRef,
        };
      })
    );

    await AsyncStorage.setItem('jobs_cache', JSON.stringify(sanitized));
    await AsyncStorage.setItem(STORAGE_KEYS.LEGACY_JOBS_CACHE, JSON.stringify(sanitized));
    await AsyncStorage.setItem(
      STORAGE_KEYS.LAST_SYNC,
      JSON.stringify(Date.now())
    );
  } catch (error: any) {
    const errorMsg = String(error?.message || error || '');
    if (errorMsg.includes('CursorWindow') || errorMsg.includes('Row too big')) {
      console.warn('Row too big to fit into CursorWindow during save! Purging corrupted jobs cache.');
      await AsyncStorage.removeItem('jobs_cache').catch(() => {});
      await AsyncStorage.removeItem(STORAGE_KEYS.LEGACY_JOBS_CACHE).catch(() => {});
    } else {
      console.warn('Failed to persist jobs into AsyncStorage:', error);
    }
  }
}

/**
 * Remove a specific job from persistent storage cache (e.g. when reassigned away).
 */
export async function removeCachedJob(jobId: string): Promise<void> {
  try {
    await AsyncStorage.multiRemove([
      `@fieldops_photo_${jobId}_before`,
      `@fieldops_photo_${jobId}_after`,
      `@fieldops_sig_${jobId}`,
    ]).catch(() => {});

    const raw = await AsyncStorage.getItem(STORAGE_KEYS.JOBS_CACHE);
    if (raw) {
      const parsed: Job[] = JSON.parse(raw);
      const remaining = parsed.filter((j) => j.id !== jobId);
      await AsyncStorage.setItem(STORAGE_KEYS.JOBS_CACHE, JSON.stringify(remaining));
    }
    const legacy = await AsyncStorage.getItem(STORAGE_KEYS.LEGACY_JOBS_CACHE);
    if (legacy) {
      const parsed: Job[] = JSON.parse(legacy);
      const remaining = parsed.filter((j) => j.id !== jobId);
      await AsyncStorage.setItem(STORAGE_KEYS.LEGACY_JOBS_CACHE, JSON.stringify(remaining));
    }
  } catch (error) {
    console.warn(`Failed to remove cached job ${jobId}:`, error);
  }
}

/**
 * Get a single job by ID from local cache
 */
export async function getCachedJobById(id: string): Promise<Job | null> {
  try {
    const jobs = await getCachedJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job) return null;

    let beforePhotoUrl = job.beforePhotoUrl;
    let afterPhotoUrl = job.afterPhotoUrl;
    let signatureData = job.signatureData;

    // Hydrate separate per-job photo or signature storage keys if referenced
    if (beforePhotoUrl === `@fieldops_photo_${id}_before` || (!beforePhotoUrl && !job.beforePhoto)) {
      const storedBefore = await AsyncStorage.getItem(`@fieldops_photo_${id}_before`).catch(() => null);
      if (storedBefore) beforePhotoUrl = storedBefore;
    }
    if (afterPhotoUrl === `@fieldops_photo_${id}_after` || (!afterPhotoUrl && !job.afterPhoto)) {
      const storedAfter = await AsyncStorage.getItem(`@fieldops_photo_${id}_after`).catch(() => null);
      if (storedAfter) afterPhotoUrl = storedAfter;
    }
    if (signatureData === `@fieldops_sig_${id}` || (!signatureData && !job.signatureData)) {
      const storedSig = await AsyncStorage.getItem(`@fieldops_sig_${id}`).catch(() => null);
      if (storedSig) signatureData = storedSig;
    }

    return {
      ...job,
      beforePhotoUrl,
      afterPhotoUrl,
      signatureData,
    };
  } catch (error) {
    console.warn(`Failed to find cached job ${id}:`, error);
    return null;
  }
}

/**
 * Update a specific job in local cache optimistically.
 * Saves any base64 or temporary photos to `${FileSystem.documentDirectory}fieldops_photos/`
 * and stores the permanent `file:///...` URI in AsyncStorage.
 * Cleans up cached disk photos once the job is marked synchronized (`is_synced === true`).
 */
export async function updateCachedJobLocally(
  jobId: string,
  updates: Partial<Job>
): Promise<Job | null> {
  try {
    const sanitizedUpdates: Partial<Job> = { ...updates };
    const isSyncComplete =
      sanitizedUpdates.is_synced === true && sanitizedUpdates.pending_sync !== true;

    const rawBefore = sanitizedUpdates.beforePhotoUrl ?? sanitizedUpdates.beforePhoto;
    const rawAfter = sanitizedUpdates.afterPhotoUrl ?? sanitizedUpdates.afterPhoto;

    if (isSyncComplete) {
      if (typeof rawBefore === 'string' && rawBefore.startsWith('data:')) {
        sanitizedUpdates.beforePhotoUrl = await savePhotoToLocalDisk(
          rawBefore,
          `job_${jobId}_before.jpg`
        );
      }
      if (typeof rawAfter === 'string' && rawAfter.startsWith('data:')) {
        sanitizedUpdates.afterPhotoUrl = await savePhotoToLocalDisk(
          rawAfter,
          `job_${jobId}_after.jpg`
        );
      }
      delete sanitizedUpdates.beforePhoto;
      delete sanitizedUpdates.afterPhoto;
    } else {
      if (rawBefore && typeof rawBefore === 'string') {
        sanitizedUpdates.beforePhotoUrl = await savePhotoToLocalDisk(
          rawBefore,
          `job_${jobId}_before_${Date.now()}.jpg`
        );
        delete sanitizedUpdates.beforePhoto;
      }

      if (rawAfter && typeof rawAfter === 'string') {
        sanitizedUpdates.afterPhotoUrl = await savePhotoToLocalDisk(
          rawAfter,
          `job_${jobId}_after_${Date.now()}.jpg`
        );
        delete sanitizedUpdates.afterPhoto;
      }
    }

    if (sanitizedUpdates.signatureData && sanitizedUpdates.signatureSvg) {
      delete sanitizedUpdates.signatureSvg;
    }

    const jobs = await getCachedJobs();
    let updatedJob: Job | null = null;
    let found = false;

    const newJobs = jobs.map((j) => {
      if (j.id === jobId) {
        found = true;
        const clientUpdatedAt =
          sanitizedUpdates.clientUpdatedAt !== undefined
            ? sanitizedUpdates.clientUpdatedAt
            : j.clientUpdatedAt || new Date().toISOString();
        let syncedAt =
          sanitizedUpdates.syncedAt !== undefined ? sanitizedUpdates.syncedAt : j.syncedAt;
        if (
          syncedAt &&
          clientUpdatedAt &&
          new Date(syncedAt).getTime() < new Date(clientUpdatedAt).getTime()
        ) {
          syncedAt = clientUpdatedAt;
        }
        const isSynced =
          sanitizedUpdates.is_synced !== undefined
            ? sanitizedUpdates.is_synced
            : sanitizedUpdates.pending_sync !== undefined
            ? !sanitizedUpdates.pending_sync
            : Boolean(sanitizedUpdates.syncedAt);
        const pendingSync =
          sanitizedUpdates.pending_sync !== undefined
            ? sanitizedUpdates.pending_sync
            : !isSynced;

        updatedJob = {
          ...j,
          ...sanitizedUpdates,
          status: sanitizedUpdates.status || j.status,
          clientUpdatedAt,
          syncedAt,
          is_synced: isSynced,
          pending_sync: pendingSync,
          version:
            sanitizedUpdates.version !== undefined
              ? sanitizedUpdates.version
              : j.version || 1,
        };
        return updatedJob;
      }
      return j;
    });

    if (found && updatedJob) {
      await saveCachedJobs(newJobs);
    } else {
      const clientUpdatedAt = sanitizedUpdates.clientUpdatedAt || new Date().toISOString();
      let syncedAt = sanitizedUpdates.syncedAt;
      if (
        syncedAt &&
        clientUpdatedAt &&
        new Date(syncedAt).getTime() < new Date(clientUpdatedAt).getTime()
      ) {
        syncedAt = clientUpdatedAt;
      }
      const isSynced =
        sanitizedUpdates.is_synced !== undefined
          ? sanitizedUpdates.is_synced
          : sanitizedUpdates.pending_sync !== undefined
          ? !sanitizedUpdates.pending_sync
          : Boolean(sanitizedUpdates.syncedAt);
      const pendingSync =
        sanitizedUpdates.pending_sync !== undefined
          ? sanitizedUpdates.pending_sync
          : !isSynced;

      updatedJob = {
        id: jobId,
        title: sanitizedUpdates.title || '',
        description: sanitizedUpdates.description || '',
        customerName: sanitizedUpdates.customerName || '',
        customerPhone: sanitizedUpdates.customerPhone || '',
        customerAddress: sanitizedUpdates.customerAddress || '',
        priority: sanitizedUpdates.priority || 'MEDIUM',
        status: sanitizedUpdates.status || 'COMPLETED',
        ...sanitizedUpdates,
        clientUpdatedAt,
        syncedAt,
        is_synced: isSynced,
        pending_sync: pendingSync,
        version: sanitizedUpdates.version !== undefined ? sanitizedUpdates.version : 1,
      } as Job;
      await saveCachedJobs([...jobs, updatedJob]);
    }

    return updatedJob;
  } catch (error) {
    console.warn(`Failed to update cached job ${jobId} locally:`, error);
    return null;
  }
}

/**
 * Save any base64 or temporary photos in a queued action body to local disk
 * (`${FileSystem.documentDirectory}fieldops_photos/`) and store the `file:///...`
 * path directly in the JSON object inside AsyncStorage.
 */
export async function sanitizeQueueBodyForStorage(
  jobId: string | undefined,
  body: any
): Promise<any> {
  if (!body || typeof body !== 'object') return body;
  const copy = { ...body };
  const prefix = jobId || 'unknown';

  const rawBefore = copy.beforePhotoUrl || copy.beforePhoto;
  if (rawBefore && typeof rawBefore === 'string') {
    if (rawBefore.startsWith('data:')) {
      await AsyncStorage.setItem(`@fieldops_photo_${prefix}_before`, rawBefore).catch(() => {});
      const diskUri = await savePhotoToLocalDisk(
        rawBefore,
        `job_${prefix}_before_${Date.now()}.jpg`
      );
      copy.beforePhotoUrl = diskUri && !diskUri.startsWith('data:') ? diskUri : `@fieldops_photo_${prefix}_before`;
    } else {
      copy.beforePhotoUrl = rawBefore;
    }
    delete copy.beforePhoto;
  }

  const rawAfter = copy.afterPhotoUrl || copy.afterPhoto;
  if (rawAfter && typeof rawAfter === 'string') {
    if (rawAfter.startsWith('data:')) {
      await AsyncStorage.setItem(`@fieldops_photo_${prefix}_after`, rawAfter).catch(() => {});
      const diskUri = await savePhotoToLocalDisk(
        rawAfter,
        `job_${prefix}_after_${Date.now()}.jpg`
      );
      copy.afterPhotoUrl = diskUri && !diskUri.startsWith('data:') ? diskUri : `@fieldops_photo_${prefix}_after`;
    } else {
      copy.afterPhotoUrl = rawAfter;
    }
    delete copy.afterPhoto;
  }

  const rawSig = copy.signatureData || copy.signatureSvg;
  if (rawSig && typeof rawSig === 'string') {
    if (rawSig.startsWith('data:') || rawSig.length > 256) {
      await AsyncStorage.setItem(`@fieldops_sig_${prefix}`, rawSig).catch(() => {});
      copy.signatureData = `@fieldops_sig_${prefix}`;
    } else {
      copy.signatureData = rawSig;
    }
    delete copy.signatureSvg;
  }

  return copy;
}

/**
 * Retrieve pending offline synchronization actions
 */
export async function getOfflineSyncQueue(): Promise<QueuedAction[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.SYNC_QUEUE);
    if (!raw) return [];
    const parsed: QueuedAction[] = JSON.parse(raw);
    return parsed;
  } catch (error: any) {
    const errorMsg = String(error?.message || error || '');
    if (errorMsg.includes('CursorWindow') || errorMsg.includes('Row too big')) {
      console.warn('Row too big to fit into CursorWindow! Purging corrupted offline sync queue.');
      try {
        await AsyncStorage.removeItem('offline_sync_queue');
        await AsyncStorage.removeItem(STORAGE_KEYS.SYNC_QUEUE);
        await AsyncStorage.removeItem('@fieldops_offline_sync_queue');
      } catch (rmErr) {
        console.warn('Error clearing corrupted queue keys:', rmErr);
      }
      return [];
    }
    console.warn('Failed to read offline sync queue:', error);
    return [];
  }
}

/**
 * Generate standard RFC4122 v4 UUID string
 */
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Enqueue an offline action to be synced later.
 * Stores action in AsyncStorage queue with photos persisted on disk as `file:///...` URIs.
 * Generates and includes an idempotencyKey (UUID) upon creation so retries send the identical key.
 */
export async function enqueueOfflineAction(
  actionOrJobId:
    | {
        endpoint: string;
        method?: string;
        body: any;
        id?: string;
        jobId?: string;
        clientVersion?: number;
        timestamp?: number;
        idempotencyKey?: string;
      }
    | string,
  legacyPayload?: any
): Promise<QueuedAction> {
  const queue = await getOfflineSyncQueue();
  let action: QueuedAction;

  if (typeof actionOrJobId === 'object') {
    const timestamp = actionOrJobId.timestamp || Date.now();
    const cachedJob = actionOrJobId.jobId
      ? await getCachedJobById(actionOrJobId.jobId)
      : null;
    const resolvedVersion =
      actionOrJobId.clientVersion ??
      actionOrJobId.body?.clientVersion ??
      cachedJob?.version ??
      1;
    const sanitizedBody = await sanitizeQueueBodyForStorage(
      actionOrJobId.jobId,
      actionOrJobId.body
    );
    const idempotencyKey =
      actionOrJobId.idempotencyKey ||
      actionOrJobId.body?.idempotencyKey ||
      generateUUID();
    action = {
      id: actionOrJobId.id || `action_${timestamp}_${Math.random().toString(36).substring(2, 7)}`,
      endpoint: actionOrJobId.endpoint,
      method: actionOrJobId.method || 'PATCH',
      body: sanitizedBody,
      timestamp,
      jobId: actionOrJobId.jobId,
      clientVersion: resolvedVersion,
      createdAt: timestamp,
      retryCount: 0,
      idempotencyKey,
    };
  } else {
    const jobId = actionOrJobId;
    const cachedJob = await getCachedJobById(jobId);
    const resolvedVersion = legacyPayload?.clientVersion ?? cachedJob?.version ?? 1;
    const isComplete = legacyPayload?.status === 'COMPLETED';
    const endpoint = isComplete ? `/jobs/${jobId}/complete` : `/jobs/${jobId}`;
    const timestamp = Date.now();
    const sanitizedBody = await sanitizeQueueBodyForStorage(jobId, {
      ...legacyPayload,
      clientUpdatedAt: legacyPayload?.clientUpdatedAt || new Date().toISOString(),
    });
    const idempotencyKey =
      legacyPayload?.idempotencyKey ||
      generateUUID();
    action = {
      id: `${jobId}_${timestamp}_${Math.random().toString(36).substring(2, 7)}`,
      endpoint,
      method: 'PATCH',
      body: sanitizedBody,
      timestamp,
      jobId,
      clientVersion: resolvedVersion,
      createdAt: timestamp,
      retryCount: 0,
      idempotencyKey,
    };
  }

  // Deduplicate existing queued actions for the same jobId + endpoint so we don't pile up stale actions
  const filteredQueue = action.jobId
    ? queue.filter((existing) => !(existing.jobId === action.jobId && existing.endpoint === action.endpoint))
    : queue;

  filteredQueue.push(action);
  const storableQueue = await Promise.all(
    filteredQueue.map(async (item) => ({
      ...item,
      body: await sanitizeQueueBodyForStorage(item.jobId, item.body),
    }))
  );
  await AsyncStorage.setItem(STORAGE_KEYS.SYNC_QUEUE, JSON.stringify(storableQueue));
  return action;
}

/**
 * Remove an item from the offline sync queue
 */
export async function removeFromOfflineQueue(queueItemId: string): Promise<void> {
  try {
    const queue = await getOfflineSyncQueue();
    const filtered = await Promise.all(
      queue
        .filter((item) => item.id !== queueItemId)
        .map(async (item) => ({
          ...item,
          body: await sanitizeQueueBodyForStorage(item.jobId, item.body),
        }))
    );
    await AsyncStorage.setItem(STORAGE_KEYS.SYNC_QUEUE, JSON.stringify(filtered));
  } catch (error) {
    console.warn(`Failed to remove item ${queueItemId} from sync queue:`, error);
  }
}

/**
 * Clear all items in the offline sync queue
 */
export async function clearOfflineQueue(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEYS.SYNC_QUEUE);
  } catch (error) {
    console.warn('Failed to clear sync queue:', error);
  }
}

/**
 * Update an existing queued action in the sync queue (e.g. retryCount, nextRetryTimestamp)
 */
export async function updateQueuedAction(updatedAction: QueuedAction): Promise<void> {
  try {
    const queue = await getOfflineSyncQueue();
    const updated = await Promise.all(
      queue.map(async (item) => {
        const target = item.id === updatedAction.id ? updatedAction : item;
        return {
          ...target,
          body: await sanitizeQueueBodyForStorage(target.jobId, target.body),
        };
      })
    );
    await AsyncStorage.setItem(STORAGE_KEYS.SYNC_QUEUE, JSON.stringify(updated));
  } catch (error) {
    console.warn(`Failed to update queued action ${updatedAction.id}:`, error);
  }
}

/**
 * Flush pending offline items to the server in chronological order.
 * If an action fails, it is retained in queue with exponential backoff.
 * Once an action succeeds, its temporary disk photos in `fieldops_photos/` are deleted.
 */
export async function flushOfflineQueue(
  syncHandler: (action: QueuedAction) => Promise<any>,
  ignoreBackoff: boolean = true
): Promise<{ syncedCount: number; pendingCount: number; errors: any[] }> {
  const queue = await getOfflineSyncQueue();
  if (queue.length === 0) {
    return { syncedCount: 0, pendingCount: 0, errors: [] };
  }

  // Iterate through queued actions in chronological order
  const sortedQueue = [...queue].sort(
    (a, b) => (a.timestamp || a.createdAt || 0) - (b.timestamp || b.createdAt || 0)
  );

  let syncedCount = 0;
  const errors: any[] = [];
  const now = Date.now();

  for (const item of sortedQueue) {
    // Only skip for backoff if ignoreBackoff is explicitly false
    if (!ignoreBackoff && item.nextRetryTimestamp && item.nextRetryTimestamp > now) {
      continue;
    }

    try {
      await syncHandler(item);
      syncedCount++;
      // Clear each successfully executed action from AsyncStorage immediately
      await removeFromOfflineQueue(item.id);
      // Delete cached disk photos now that the server has persisted the job
      if (item.jobId) {
        await cleanupSyncedJobPhotos(item.jobId, [
          item.body?.beforePhotoUrl,
          item.body?.afterPhotoUrl,
        ]);
      }
    } catch (err) {
      console.warn(`Failed to sync queued item ${item.id} (${item.endpoint}):`, err);
      errors.push(err);

      // Keep in queue with exponential backoff (2s, 4s, 8s, up to 30s)
      const currentRetries = (item.retryCount || 0) + 1;
      const backoffDelay = Math.min(2000 * Math.pow(2, currentRetries - 1), 30000);
      item.retryCount = currentRetries;
      item.nextRetryTimestamp = Date.now() + backoffDelay;

      await updateQueuedAction(item);
    }
  }

  await AsyncStorage.setItem(STORAGE_KEYS.LAST_SYNC, JSON.stringify(Date.now()));

  const remaining = await getOfflineSyncQueue();
  return {
    syncedCount,
    pendingCount: remaining.length,
    errors,
  };
}

/**
 * Get timestamp of last successful sync
 */
export async function getLastSyncTimestamp(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.LAST_SYNC);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const API_URL_OVERRIDE_KEY = '@fieldops_api_url_override';

/**
 * Retrieve explicit manual API URL override from AsyncStorage
 */
export async function getApiUrlOverride(): Promise<string | null> {
  try {
    const override = await AsyncStorage.getItem(API_URL_OVERRIDE_KEY);
    return override && override.trim() ? override.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Persist or clear explicit manual API URL override in AsyncStorage
 */
export async function setApiUrlOverride(url: string | null): Promise<void> {
  try {
    if (!url || !url.trim()) {
      await AsyncStorage.removeItem(API_URL_OVERRIDE_KEY);
    } else {
      const cleaned = url.trim().replace(/\/+$/, '');
      const normalized = cleaned.endsWith('/api') ? cleaned : `${cleaned}/api`;
      await AsyncStorage.setItem(API_URL_OVERRIDE_KEY, normalized);
    }
  } catch (err) {
    console.warn('Failed to save API URL override:', err);
  }
}

