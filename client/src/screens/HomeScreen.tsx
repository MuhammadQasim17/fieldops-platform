import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Job, RootStackParamList, User } from '../types';
import { useAuth } from '../context/AuthContext';
import {
  apiRequest,
  getJobs,
  getPendingSyncCount,
  initNetworkAutoSync,
  logoutUser,
  onJobCacheUpdated,
  onQueueDrained,
  onSyncStateChange,
  subscribeToRealtimeEvents,
  syncOfflineData,
  updateCachedJobLocally,
  removeCachedJob,
} from '../services/api';
import {
  getAuthToken,
  getAuthUser,
  getCachedJobs,
  saveCachedJobs,
} from '../services/storage';
import { JobCard } from '../components/JobCard';
import { RoleBadge } from '../components/Badge';
import { ConnectivityBanner } from '../components/ConnectivityBanner';
import NetInfo, { useNetInfo } from '@react-native-community/netinfo';

type HomeScreenNavProp = NativeStackNavigationProp<RootStackParamList, 'Home'>;

const getStatusWeight = (status: string) => {
  switch (status) {
    case 'IN_PROGRESS':
      return 1;
    case 'EN_ROUTE':
      return 2;
    case 'PENDING':
      return 3;
    case 'COMPLETED':
      return 4;
    case 'CANCELLED':
      return 5;
    default:
      return 3;
  }
};

const sortJobsList = (list: Job[]) => {
  return [...list].sort((a, b) => {
    const timeA = new Date(a.createdAt || 0).getTime();
    const timeB = new Date(b.createdAt || 0).getTime();
    if (timeB !== timeA) {
      return timeB - timeA;
    }
    return (b.id || '').localeCompare(a.id || '');
  });
};

const areJobListsEqual = (prevList: Job[], nextList: Job[]): boolean => {
  if (prevList === nextList) return true;
  if (!prevList || !nextList || prevList.length !== nextList.length) return false;

  for (let i = 0; i < prevList.length; i++) {
    const p = prevList[i];
    const n = nextList[i];
    if (
      p.id !== n.id ||
      p.status !== n.status ||
      p.priority !== n.priority ||
      p.updatedAt !== n.updatedAt ||
      p.clientUpdatedAt !== n.clientUpdatedAt ||
      p.technicianId !== n.technicianId ||
      p.title !== n.title ||
      p.customerName !== n.customerName ||
      p.customerAddress !== n.customerAddress ||
      p.totalAmount !== n.totalAmount ||
      p.laborCost !== n.laborCost ||
      p.is_synced !== n.is_synced ||
      p.pending_sync !== n.pending_sync ||
      p.completionNotes !== n.completionNotes ||
      p.materialsUsed !== n.materialsUsed ||
      p.customServices !== n.customServices
    ) {
      return false;
    }
  }

  return true;
};

export const HomeScreen: React.FC = () => {
  const navigation = useNavigation<HomeScreenNavProp>();
  const { signOut, handleForceSignOut } = useAuth();
  const netInfo = useNetInfo();
  const isOnline = netInfo.isConnected !== false && netInfo.isInternetReachable !== false;
  const isConfirmedOffline =
    netInfo.isConnected === false ||
    (netInfo.isConnected === true && netInfo.isInternetReachable === false);

  type StatusFilterType = 'ALL' | 'ACTIVE' | 'COMPLETED';
  const [filter, setFilter] = useState<StatusFilterType>('ALL');
  const [activeStaff, setActiveStaff] = useState<User | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOfflineFetchError, setIsOfflineFetchError] = useState(false);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [syncingQueue, setSyncingQueue] = useState(false);
  const jobsRef = useRef<Job[]>(jobs);
  jobsRef.current = jobs;

  const handleSelectJob = useCallback((job: Job) => {
    navigation.navigate('JobDetail', { jobId: job.id });
  }, [navigation]);

  // Ref guards to prevent memory leaks and race conditions
  const isMountedRef = useRef(true);
  const activeFetchAbortRef = useRef<AbortController | null>(null);
  const isPollingRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (activeFetchAbortRef.current) {
        activeFetchAbortRef.current.abort();
      }
    };
  }, []);

  // 1. Initial authenticated user resolution on mount (Cache-First)
  useEffect(() => {
    let isCancelled = false;

    const initActiveStaff = async () => {
      try {
        const [token, user] = await Promise.all([
          getAuthToken(),
          getAuthUser(),
        ]);

        if (isCancelled || !isMountedRef.current) return;

        if (!token || !user) {
          // Not authenticated; redirect to login
          await handleForceSignOut();
          navigation.reset({
            index: 0,
            routes: [{ name: 'Login' }],
          });
          return;
        }

        // Immediately load and render cached work orders with zero delay (stale-while-revalidate)
        try {
          const cached = await getCachedJobs(user.id);
          if (cached && cached.length > 0 && isMountedRef.current) {
            const sorted = sortJobsList(cached);
            setJobs(sorted);
            jobsRef.current = sorted;
            setLoading(false);
          }
        } catch (cacheErr) {
          console.warn('Initial cache load error:', cacheErr);
        }

        setActiveStaff(user);
      } catch (err) {
        console.error('Failed to initialize active staff:', err);
      }
    };

    initActiveStaff();

    return () => {
      isCancelled = true;
    };
  }, [navigation]);

  const handleSignOut = useCallback(
    (force: boolean = false) => {
      const doLogout = async () => {
        try {
          if (force) {
            await handleForceSignOut();
          } else {
            await signOut();
          }
          navigation.reset({
            index: 0,
            routes: [{ name: 'Login' }],
          });
        } catch (err) {
          console.warn('Sign out error:', err);
        }
      };

      if (force === true) {
        doLogout();
        return;
      }

      Alert.alert(
        'Sign Out',
        `Are you sure you want to sign out from ${activeStaff?.name || 'FieldOps'}? Queued offline changes will remain safely preserved on this device.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Sign Out',
            style: 'destructive',
            onPress: doLogout,
          },
        ]
      );
    },
    [handleForceSignOut, signOut, navigation, activeStaff?.name]
  );

  const handleForceLogout = useCallback(async () => {
    // 1. Wipe local job list state to prevent old tasks from showing
    setJobs([]);
    // 2. Clear local storage / AsyncStorage auth session
    await AsyncStorage.multiRemove([
      'user',
      'token',
      'cached_jobs',
      'auth_token',
      'user_profile',
      'fieldops_user',
      'fieldops_tech_id',
      'offline_jobs',
      '@fieldops_jobs_cache',
      'has_prompted_gps',
    ]);
    await AsyncStorage.removeItem('has_prompted_gps');
    // 3. Reset auth state and return to login screen
    await handleForceSignOut();
    navigation.reset({
      index: 0,
      routes: [{ name: 'Login' }],
    });
    Alert.alert(
      'Access Revoked',
      'Your account has been removed from the team directory. Please contact your dispatch supervisor.'
    );
  }, [handleForceSignOut, navigation]);

  // 2. Stable job fetch function with abort controller and mount guards
  const fetchAssignedJobs = useCallback(
    async (staffId: string, isRefresh = false, isSilent = false) => {
      if (!staffId) {
        if (isMountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
        return;
      }

      if (activeFetchAbortRef.current) {
        activeFetchAbortRef.current.abort();
      }
      const abortController = new AbortController();
      activeFetchAbortRef.current = abortController;

      // Strictly DO NOT toggle loading or refreshing states during background sync
      if (!isSilent) {
        if (isRefresh) {
          setRefreshing(true);
        } else if (jobsRef.current.length === 0) {
          setLoading(true);
        }
      }
      setError(null);

      try {
        const [pendingCount, jobsResult] = await Promise.all([
          getPendingSyncCount(),
          getJobs(staffId, { skipOfflineSync: isSilent }),
        ]);

        if (!isMountedRef.current || abortController.signal.aborted) return;

        setPendingSyncCount(pendingCount);

        const rawList = jobsResult?.jobs;
        const jobArray = Array.isArray(rawList)
          ? rawList
          : Array.isArray(jobsResult)
          ? jobsResult
          : [];
        const sortedIncoming = sortJobsList(jobArray);
        // Silent State Update: Only update state if jobs list or statuses actually changed
        if (!areJobListsEqual(jobsRef.current, sortedIncoming)) {
          setJobs(sortedIncoming);
        }

        if (jobsResult.fromCache) {
          // getJobs fell back to local cache because an actual network request failed
          const netState = await NetInfo.fetch().catch(() => null);
          const isNetOffline =
            netState?.isConnected === false ||
            (netState?.isConnected === true && netState?.isInternetReachable === false);

          setIsOfflineFetchError(isNetOffline);
        } else {
          // Successful live network fetch
          setIsOfflineFetchError(false);
        }

        // Recheck pending queue count after opportunistic flush
        const updatedCount = await getPendingSyncCount();
        if (isMountedRef.current && !abortController.signal.aborted) {
          setPendingSyncCount(updatedCount);
        }
      } catch (err: any) {
        if (!isMountedRef.current) return;
        const errMsg = err?.message || '';
        const status = err?.status || err?.statusCode || (errMsg.includes('403') ? 403 : 0);
        if (
          status === 403 ||
          errMsg.includes('NOT_A_MEMBER') ||
          errMsg.includes('ACCOUNT_DELETED') ||
          errMsg.includes('revoked') ||
          errMsg.includes('removed') ||
          errMsg.includes('deactivated')
        ) {
          console.warn('[HomeScreen] Worker account removed or deactivated. Forcing logout.');
          await handleForceLogout();
          return;
        }

        console.warn('[Jobs] Error fetching assigned jobs:', err);
        if (jobsRef.current.length === 0) {
          setJobs([]);
        }

        if (!isSilent) {
          const netState = await NetInfo.fetch().catch(() => null);
          const isNetOffline =
            netState?.isConnected === false ||
            (netState?.isConnected === true && netState?.isInternetReachable === false);

          if (isNetOffline) {
            setIsOfflineFetchError(true);
          }

          if (jobsRef.current.length === 0) {
            setError('Unable to load work orders. Please check your network connection.');
          }
        }
      } finally {
        if (isMountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [handleSignOut]
  );

  // Force live network fetch for new dispatches and verify active worker status
  const handleCheckNewDispatches = useCallback(async () => {
    const currentTechId = activeStaff?.id;
    if (!currentTechId) {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
      return;
    }

    try {
      setRefreshing(true);
      // Force live network fetch with cache-busting timestamp
      const freshJobs = await apiRequest<Job[]>(`/jobs?assignedTechId=${currentTechId}&t=${Date.now()}`);
      const validArray = Array.isArray(freshJobs) ? freshJobs : [];
      const sorted = sortJobsList(validArray);
      setJobs(sorted);
      await saveCachedJobs(sorted, currentTechId);
      setIsOfflineFetchError(false);
    } catch (err: any) {
      const errMsg = err?.message || '';
      const status = err?.status || err?.statusCode || (errMsg.includes('403') ? 403 : 0);
      if (
        status === 403 ||
        errMsg.includes('NOT_A_MEMBER') ||
        errMsg.includes('ACCOUNT_DELETED') ||
        errMsg.includes('ACCOUNT_NOT_FOUND') ||
        errMsg.includes('revoked') ||
        errMsg.includes('removed') ||
        errMsg.includes('deactivated')
      ) {
        await handleForceLogout();
        return;
      }
      console.warn('[Jobs] Error fetching fresh jobs:', err);
      Alert.alert('Sync Notice', 'Unable to reach dispatch server.');
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [activeStaff?.id, handleSignOut]);

  // Pull-to-refresh handler supporting both populated and empty states
  const onRefresh = useCallback(async () => {
    try {
      setRefreshing(true);
      try {
        await syncOfflineData();
      } catch (e: any) {
        const msg = e?.message || '';
        if (msg.includes('ACCOUNT_DELETED') || msg.includes('revoked') || msg.includes('removed')) {
          await handleSignOut(true);
          return;
        }
        console.warn('Pull-to-refresh sync error:', e);
      }
      await handleCheckNewDispatches();
    } catch (err) {
      console.warn('[Jobs] Pull-to-refresh error:', err);
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [handleCheckNewDispatches, handleSignOut]);

  // 3. Fire job fetch whenever activeStaff.id is set (silent if cached jobs already populated)
  useEffect(() => {
    if (activeStaff?.id) {
      const hasCached = jobsRef.current.length > 0;
      fetchAssignedJobs(activeStaff.id, false, hasCached);
    }
  }, [activeStaff?.id, fetchAssignedJobs]);

  // Auto-sync & queue drainage listener:
  useEffect(() => {
    // 1. Listen for queue completion. When flushOfflineQueue() finishes draining (queue length becomes 0),
    // automatically trigger fetchAssignedJobs(activeStaff.id) to refresh the UI immediately.
    const unsubDrain = onQueueDrained(() => {
      if (activeStaff?.id && isMountedRef.current) {
        fetchAssignedJobs(activeStaff.id, false, true);
      }
    });

    // 2. Track pending sync count without popping up syncing banners on background syncs
    const unsubSyncState = onSyncStateChange(() => {
      if (isMountedRef.current) {
        getPendingSyncCount().then((count) => {
          if (isMountedRef.current) setPendingSyncCount(count);
        });
      }
    });

    // 3. Listen for immediate optimistic local updates (e.g. order completed offline)
    const unsubJobUpdate = onJobCacheUpdated((jobId, updates) => {
      if (!isMountedRef.current) return;
      setJobs((prevJobs) =>
        sortJobsList(prevJobs.map((j) => (j.id === jobId ? { ...j, ...updates } : j)))
      );
      getPendingSyncCount().then((count) => {
        if (isMountedRef.current) setPendingSyncCount(count);
      });
    });

    // 4. Resilient background auto-sync on network reconnect
    const unsubNetwork = initNetworkAutoSync(() => {
      if (activeStaff?.id && isMountedRef.current) {
        fetchAssignedJobs(activeStaff.id, false, true);
      }
    });

    return () => {
      unsubDrain();
      unsubSyncState();
      unsubJobUpdate();
      unsubNetwork();
    };
  }, [activeStaff?.id, fetchAssignedJobs]);

  // 4. Focus sync: check if session is still valid when returning to screen
  useFocusEffect(
    useCallback(() => {
      let isFocused = true;

      const onFocusSync = async () => {
        try {
          const authUser = await getAuthUser();
          if (!isFocused || !isMountedRef.current) return;

          if (authUser) {
            setActiveStaff(authUser);
            // Immediately render latest cached jobs with zero delay
            const cached = await getCachedJobs(authUser.id);
            if (cached && cached.length > 0 && isMountedRef.current) {
              setJobs(sortJobsList(cached));
              setLoading(false);
            }
            // Silent background network synchronization
            fetchAssignedJobs(authUser.id, false, true);
          }
        } catch (err) {
          console.warn('Focus sync error:', err);
        }
      };

      onFocusSync();

      return () => {
        isFocused = false;
      };
    }, [fetchAssignedJobs])
  );

  // Fallback fast background polling interval (every 4 seconds) while screen is focused
  useFocusEffect(
    useCallback(() => {
      if (!activeStaff?.id) return;
      const staffId = activeStaff.id;
      const interval = setInterval(async () => {
        if (isPollingRef.current) return;
        isPollingRef.current = true;
        try {
          await fetchAssignedJobs(staffId, false, true);
        } catch (err) {
          // Silent catch to prevent fatal unhandled rejection
        } finally {
          isPollingRef.current = false;
        }
      }, 4000);
      return () => {
        clearInterval(interval);
        isPollingRef.current = false;
      };
    }, [activeStaff?.id, fetchAssignedJobs])
  );

  // Real-time Push Notifications for Assigned Jobs (SSE Stream)
  useEffect(() => {
    if (!activeStaff?.id) return;

    const unsubEvents = subscribeToRealtimeEvents(async (eventType, data) => {
      if (!isMountedRef.current || !activeStaff?.id) return;

      if (eventType === 'STAFF_REMOVED') {
        const removedTechId = data?.technicianId || data?.id;
        if (removedTechId === activeStaff.id) {
          console.warn('[SSE] Staff revocation received for current user. Forcing logout.');
          await handleForceLogout();
          return;
        }
      }

      if (
        eventType === 'JOB_ASSIGNED' ||
        eventType === 'JOB_UPDATED' ||
        eventType === 'JOB_REASSIGNED' ||
        eventType === 'NEW_JOB' ||
        eventType === 'JOB_CREATED'
      ) {
        const currentUserId = activeStaff.id;
        const targetJob: Job | null = data?.job || (data?.id ? data : null);
        const jobId: string = data?.jobId || data?.id || targetJob?.id;
        const assignedTechId =
          data?.assignedTechId !== undefined
            ? data.assignedTechId
            : targetJob?.technicianId || targetJob?.technician?.id;
        const previousTechId = data?.previousTechId;

        // 1. If job was reassigned away from current user:
        if (previousTechId === currentUserId && assignedTechId !== currentUserId) {
          if (jobId) {
            setJobs((prev) => prev.filter((j) => j.id !== jobId));
            removeCachedJob(jobId).catch((err) => console.warn('Cache removal error:', err));
          }
        } else if (assignedTechId === currentUserId || !assignedTechId) {
          // 2. If assigned/reassigned to current technician (or newly dispatched):
          if (targetJob) {
            setJobs((prev) => {
              const exists = prev.some((j) => j.id === targetJob.id);
              const updated = exists
                ? prev.map((j) => (j.id === targetJob.id ? { ...j, ...targetJob } : j))
                : [targetJob, ...prev];
              const sorted = sortJobsList(updated);
              return areJobListsEqual(prev, sorted) ? prev : sorted;
            });
            updateCachedJobLocally(targetJob.id, targetJob).catch((err) =>
              console.warn('Cache update error:', err)
            );
          }
          fetchAssignedJobs(currentUserId, false, true);
        } else {
          // 3. Normal update for a job in current list
          const wasInCurrentList = jobsRef.current.some((j) => j.id === jobId);
          if (wasInCurrentList && targetJob) {
            setJobs((prev) => {
              const updated = prev.map((j) => (j.id === targetJob.id ? { ...j, ...targetJob } : j));
              const sorted = sortJobsList(updated);
              return areJobListsEqual(prev, sorted) ? prev : sorted;
            });
            updateCachedJobLocally(targetJob.id, targetJob).catch((err) =>
              console.warn('Cache update error:', err)
            );
          }
          fetchAssignedJobs(currentUserId, false, true);
        }
      }
    });

    return () => {
      unsubEvents();
    };
  }, [activeStaff?.id, fetchAssignedJobs]);

  useFocusEffect(
    React.useCallback(() => {
      const onBackPress = () => {
        BackHandler.exitApp();
        return true;
      };
      const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => subscription.remove();
    }, [])
  );



  const handleManualSync = async () => {
    if (!activeStaff?.id) return;
    setSyncingQueue(true);
    try {
      const syncResult = await syncOfflineData();
      if (syncResult.syncedCount > 0) {
        Alert.alert(
          'Sync Complete',
          `Successfully synchronized ${syncResult.syncedCount} queued work order ${
            syncResult.syncedCount === 1 ? 'change' : 'changes'
          }.`
        );
      } else if (syncResult.pendingCount === 0) {
        Alert.alert('Up to Date', 'All work orders are synchronized with the server.');
      }
      await fetchAssignedJobs(activeStaff.id, false, true);
    } catch (err: any) {
      console.warn('Manual sync failed:', err);
      Alert.alert('Sync Offline', 'Server unreachable. Queued changes remain safe locally.');
    } finally {
      if (isMountedRef.current) {
        setSyncingQueue(false);
      }
    }
  };

  const renderJobItem = useCallback(
    ({ item }: { item: Job }) => (
      <JobCard job={item} onPress={() => handleSelectJob(item)} />
    ),
    [handleSelectJob]
  );

  const getInitials = (name?: string) => {
    if (!name) return '??';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return parts[0].substring(0, 2).toUpperCase();
  };

  const filteredJobs = useMemo(() => {
    if (filter === 'ACTIVE') {
      return jobs.filter(
        (j) => j.status === 'PENDING' || j.status === 'IN_PROGRESS' || j.status === 'EN_ROUTE'
      );
    }
    if (filter === 'COMPLETED') {
      return jobs.filter((j) => j.status === 'COMPLETED');
    }
    return jobs;
  }, [jobs, filter]);

  const allCount = jobs.length;
  const activeCount = useMemo(
    () =>
      jobs.filter(
        (j) => j.status === 'PENDING' || j.status === 'EN_ROUTE' || j.status === 'IN_PROGRESS'
      ).length,
    [jobs]
  );
  const completedCount = useMemo(
    () => jobs.filter((j) => j.status === 'COMPLETED').length,
    [jobs]
  );

  const pendingCount = activeCount;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {/* Global Connectivity Banner / Status Pill */}
      <ConnectivityBanner />

      {/* Top Mobile Header with Authenticated Technician Profile Badge & Sign Out Button */}
      <View style={styles.header}>
        <View style={styles.headerTopRow}>
          <View style={styles.profileBadge}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{getInitials(activeStaff?.name)}</Text>
            </View>
            <View style={styles.profileTextContainer}>
              <View style={styles.profileNameRow}>
                <Text style={styles.profileName} numberOfLines={1}>
                  {activeStaff ? activeStaff.name : 'Field Technician'}
                </Text>
                <Ionicons name="checkmark-circle" size={14} color="#059669" />
              </View>
              <View style={styles.roleRow}>
                <RoleBadge role={activeStaff?.role} size="small" />
              </View>
            </View>
          </View>

          <View style={styles.headerActions}>
            <TouchableOpacity
              onPress={() => handleSignOut()}
              style={styles.signOutButton}
              activeOpacity={0.7}
            >
              <Ionicons name="log-out-outline" size={16} color="#DC2626" />
              <Text style={styles.signOutButtonText}>Sign Out</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleManualSync}
              style={styles.syncButton}
              activeOpacity={0.7}
              disabled={syncingQueue}
            >
              {syncingQueue ? (
                <ActivityIndicator size="small" color="#2563EB" />
              ) : (
                <Ionicons name="sync" size={18} color="#2563EB" />
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* Section Title & Scoped Counter */}
        <View style={styles.headerBottomRow}>
          <Text style={styles.sectionTitle}>Assigned Work Orders</Text>
          <Text style={styles.activeOrdersCounter}>
            {pendingCount} active {pendingCount === 1 ? 'dispatch' : 'dispatches'}
          </Text>
        </View>
      </View>

      {/* Horizontal Status Filter Bar */}
      <View style={styles.filterBar}>
        <TouchableOpacity
          style={[styles.filterChip, filter === 'ALL' && styles.filterChipActive]}
          onPress={() => setFilter('ALL')}
          activeOpacity={0.7}
        >
          <Text style={[styles.filterChipText, filter === 'ALL' && styles.filterChipTextActive]}>
            All ({allCount})
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterChip, filter === 'ACTIVE' && styles.filterChipActive]}
          onPress={() => setFilter('ACTIVE')}
          activeOpacity={0.7}
        >
          <Text style={[styles.filterChipText, filter === 'ACTIVE' && styles.filterChipTextActive]}>
            Active ({activeCount})
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.filterChip, filter === 'COMPLETED' && styles.filterChipActive]}
          onPress={() => setFilter('COMPLETED')}
          activeOpacity={0.7}
        >
          <Text style={[styles.filterChipText, filter === 'COMPLETED' && styles.filterChipTextActive]}>
            Completed ({completedCount})
          </Text>
        </TouchableOpacity>
      </View>

      {/* Offline Status & Pending Sync Banner */}
      {((isConfirmedOffline && isOfflineFetchError) || pendingSyncCount > 0) && (
        <View style={styles.offlineBanner}>
          <View style={styles.offlineBannerContent}>
            <Ionicons
              name={pendingSyncCount > 0 ? 'cloud-upload-outline' : 'cloud-offline-outline'}
              size={18}
              color="#B45309"
            />
            <Text style={styles.offlineBannerText}>
              {pendingSyncCount > 0
                ? `${pendingSyncCount} change${pendingSyncCount === 1 ? '' : 's'} queued offline`
                : 'Offline Mode: Showing cached work orders'}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.syncNowBtn}
            onPress={handleManualSync}
            disabled={syncingQueue}
          >
            <Text style={styles.syncNowText}>Sync Now</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Subtle Active Flushing / Syncing Indicator */}
      {syncingQueue && (
        <View style={styles.syncingBanner}>
          <ActivityIndicator size="small" color="#2563EB" />
          <Text style={styles.syncingText}>Syncing offline actions...</Text>
        </View>
      )}

      {/* Main Jobs FlatList */}
      {loading && jobs.length === 0 ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#2563EB" />
          <Text style={styles.loadingText}>Loading assigned work orders...</Text>
        </View>
      ) : error && jobs.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.emptyScrollContainer}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={['#2563EB']}
              tintColor="#2563EB"
            />
          }
        >
          <View style={styles.centerContainer}>
            <Ionicons name="alert-circle-outline" size={48} color="#EF4444" />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => {
                if (activeStaff?.id) {
                  fetchAssignedJobs(activeStaff.id);
                }
              }}
            >
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      ) : filteredJobs.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.emptyScrollContainer}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={['#2563EB']}
              tintColor="#2563EB"
            />
          }
        >
          <View style={styles.emptyContainer}>
            <Ionicons name="clipboard-outline" size={54} color="#94A3B8" />
            <Text style={styles.emptyTitle}>
              {filter === 'ACTIVE'
                ? 'No Active Work Orders'
                : filter === 'COMPLETED'
                ? 'No Completed Work Orders'
                : 'No Work Orders Assigned'}
            </Text>
            <Text style={styles.emptySubtitle}>
              {filter === 'ACTIVE'
                ? 'All tasks are either completed or pending assignment.'
                : filter === 'COMPLETED'
                ? 'No completed tasks found in this session.'
                : 'You are all caught up! New dispatch assignments from your supervisor will appear here.'}
            </Text>
            <TouchableOpacity
              style={styles.refreshPromptBtn}
              onPress={onRefresh}
              activeOpacity={0.7}
            >
              <Ionicons name="refresh-outline" size={16} color="#2563EB" />
              <Text style={styles.refreshPromptText}>Check for New Dispatches</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      ) : (
        <FlatList
          data={filteredJobs}
          keyExtractor={(item) => item.id.toString()}
          renderItem={renderJobItem}
          initialNumToRender={8}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews={true}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={['#2563EB']}
              tintColor="#2563EB"
            />
          }
        />
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  profileBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    paddingRight: 8,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  profileTextContainer: {
    flex: 1,
  },
  profileNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  profileName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
  },
  roleRow: {
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FEE2E2',
  },
  signOutButtonText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#DC2626',
  },
  syncButton: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
  },
  headerBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingTop: 4,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#111827',
  },
  activeOrdersCounter: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
  },
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  filterChip: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: '#F1F5F9',
  },
  filterChipActive: {
    backgroundColor: '#2563EB',
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748B',
  },
  filterChipTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  offlineBanner: {
    backgroundColor: '#FEF3C7',
    borderBottomWidth: 1,
    borderBottomColor: '#FDE68A',
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  offlineBannerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  offlineBannerText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#92400E',
    flexShrink: 1,
  },
  syncNowBtn: {
    backgroundColor: '#D97706',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  syncNowText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
  list: {
    padding: 16,
    paddingBottom: 24,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  emptyScrollContainer: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 40,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#6B7280',
  },
  errorText: {
    marginTop: 12,
    fontSize: 14,
    color: '#374151',
    textAlign: 'center',
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 54,
    paddingHorizontal: 24,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#374151',
  },
  emptySubtitle: {
    fontSize: 13,
    color: '#94A3B8',
    textAlign: 'center',
    lineHeight: 18,
    maxWidth: 320,
  },
  refreshPromptBtn: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  refreshPromptText: {
    color: '#2563EB',
    fontSize: 13,
    fontWeight: '700',
  },
  syncingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#EFF6FF',
    borderColor: '#BFDBFE',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 12,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  syncingText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1D4ED8',
  },
  floatingAlertContainer: {
    position: 'absolute',
    top: 8,
    left: 12,
    right: 12,
    zIndex: 9999,
    elevation: 20,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28,
    shadowRadius: 10,
  },
  floatingAlertBanner: {
    backgroundColor: '#0F172A',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#3B82F6',
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  floatingAlertLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    marginRight: 8,
  },
  floatingAlertIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  floatingAlertTextWrap: {
    flex: 1,
  },
  floatingAlertTitle: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  floatingAlertSubtitle: {
    color: '#93C5FD',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  floatingAlertCloseBtn: {
    padding: 4,
  },
});

export { HomeScreen as JobsScreen };
