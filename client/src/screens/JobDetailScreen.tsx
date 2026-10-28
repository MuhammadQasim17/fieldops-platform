import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Image,
  Linking,
  LogBox,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import { RouteProp, useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { Job, JobStatus, RootStackParamList } from '../types';
import { getJobById, initNetworkAutoSync, updateJob, sendJobLocation, getSystemSettings, SystemSettings } from '../services/api';
import { PriorityBadge, StatusBadge } from '../components/Badge';
import { ConnectivityBanner } from '../components/ConnectivityBanner';

type JobDetailRouteProp = RouteProp<RootStackParamList, 'JobDetail'>;
type JobDetailNavProp = NativeStackNavigationProp<RootStackParamList, 'JobDetail'>;

// Suppress visual LogBox toast warning popups for non-fatal background GPS pings
LogBox.ignoreLogs([
  'Initial GPS location ping failed',
  'Periodic GPS location ping failed',
  'Foreground location permission not granted for live tracking',
  '[GPS]',
]);

/**
 * Haversine formula to calculate the great-circle distance (in meters)
 * between two GPS coordinates (latitude/longitude).
 */
export function calculateHaversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const EARTH_RADIUS_METERS = 6371000; // 6,371 km in meters
  const toRadians = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

const normalizePhotoUri = (raw?: string | null): string | null => {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith('data:') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('file://') ||
    trimmed.startsWith('content://')
  ) {
    return trimmed;
  }
  if (trimmed.startsWith('/')) {
    return `file://${trimmed}`;
  }
  if (trimmed.length > 100 && !trimmed.includes(' ') && !trimmed.includes('/')) {
    return `data:image/jpeg;base64,${trimmed}`;
  }
  return trimmed;
};

export const JobDetailScreen: React.FC = () => {
  const route = useRoute<JobDetailRouteProp>();
  const navigation = useNavigation<JobDetailNavProp>();
  const { jobId } = route.params;

  const [job, setJob] = useState<Job | null>(null);
  const [beforePhoto, setBeforePhoto] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFromCache, setIsFromCache] = useState(false);
  const [systemSettings, setSystemSettings] = useState<SystemSettings | null>(null);
  const hasTriggeredAutoArrivalRef = useRef<boolean>(false);
  const locationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getSystemSettings()
      .then((settings) => {
        if (settings) setSystemSettings(settings);
      })
      .catch(() => {});
  }, []);

  const baseLaborFee = typeof job?.laborCost === 'number' && job.laborCost >= 0 
    ? job.laborCost 
    : (systemSettings?.defaultBaseLaborFee ?? (job?.laborCost ?? 0));

  const fetchJobDetails = useCallback(async () => {
    setError(null);
    try {
      const { job: data, fromCache } = await getJobById(jobId);
      setJob(data);
      if (data?.beforePhotoUrl && typeof data.beforePhotoUrl === 'string') {
        setBeforePhoto(data.beforePhotoUrl);
      }
      setIsFromCache(fromCache);
    } catch (err: any) {
      console.error('Failed to load job details:', err);
      setError('Could not load work order details.');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useFocusEffect(
    useCallback(() => {
      fetchJobDetails();
    }, [fetchJobDetails])
  );

  // Configure back button (headerLeft & hardware BackHandler) to return to JobList (active roster)
  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        navigation.navigate('JobList');
        return true;
      };

      const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => subscription.remove();
    }, [navigation])
  );

  useEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <TouchableOpacity
          onPress={() => navigation.navigate('JobList')}
          style={{ paddingHorizontal: 8, paddingVertical: 6, flexDirection: 'row', alignItems: 'center' }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-back" size={24} color="#2563EB" />
          <Text style={{ fontSize: 16, color: '#2563EB', fontWeight: '500', marginLeft: -4 }}>Jobs</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  useEffect(() => {
    const unsub = initNetworkAutoSync(() => {
      fetchJobDetails();
    });
    return () => {
      unsub();
    };
  }, [fetchJobDetails]);

  // Real-Time Technician GPS Location Streaming & Geofencing Auto-Arrival while EN_ROUTE (10s interval)
  useEffect(() => {
    let isActive = true;

    if (job?.status !== 'EN_ROUTE') {
      hasTriggeredAutoArrivalRef.current = false;
      if (locationIntervalRef.current) {
        clearInterval(locationIntervalRef.current);
        locationIntervalRef.current = null;
      }
    }

    const evaluateGeofenceAutoArrival = async (currentLat: number, currentLng: number) => {
      if (
        !isActive ||
        !job ||
        job.status !== 'EN_ROUTE' ||
        hasTriggeredAutoArrivalRef.current ||
        typeof job.latitude !== 'number' ||
        typeof job.longitude !== 'number'
      ) {
        return;
      }

      const distanceMeters = calculateHaversineDistanceMeters(
        currentLat,
        currentLng,
        job.latitude,
        job.longitude
      );

      // Geofence threshold: <= 100 meters (0.1 km)
      if (distanceMeters <= 100) {
        hasTriggeredAutoArrivalRef.current = true;
        Vibration.vibrate([0, 250, 100, 250]);

        try {
          setUpdating(true);
          const result = await updateJob(job.id, { status: 'IN_PROGRESS' });
          if (isActive) {
            setJob(result.job);
          }
          Alert.alert(
            'Technician Arrived On-Site',
            `You are within ${Math.round(distanceMeters)}m of the service address. Work order status has automatically transitioned to IN PROGRESS.`,
            [
              {
                text: 'Capture Pre-Service Photo',
                onPress: () => promptBeforePhotoSource(),
              },
              {
                text: 'OK',
              },
            ]
          );
        } catch (geofenceErr) {
          console.warn('Geofence auto-arrival status transition failed:', geofenceErr);
          hasTriggeredAutoArrivalRef.current = false;
        } finally {
          if (isActive) {
            setUpdating(false);
          }
        }
      }
    };

    const startLocationStreaming = async () => {
      if (job?.status !== 'EN_ROUTE' || !isActive) return;

      try {
        // Silently check foreground location permissions without triggering intrusive prompts
        const permission = await Location.getForegroundPermissionsAsync().catch(() => null);
        if (!isActive || permission?.status !== 'granted') {
          console.warn('[GPS] Foreground location permission not granted for live tracking, continuing silently.');
          return;
        }

        // Silently check if GPS hardware / location services are toggled on
        const isServicesEnabled = await Location.hasServicesEnabledAsync().catch(() => true);
        if (!isActive || !isServicesEnabled) {
          console.warn('[GPS] Device location services or GPS hardware toggled off, continuing silently.');
          return;
        }

        // Send immediate initial GPS coordinate ping upon becoming EN_ROUTE
        try {
          const initialLoc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          if (!isActive) return;
          if (initialLoc?.coords) {
            await sendJobLocation(jobId, {
              latitude: initialLoc.coords.latitude,
              longitude: initialLoc.coords.longitude,
              timestamp: Date.now(),
            });
            await evaluateGeofenceAutoArrival(
              initialLoc.coords.latitude,
              initialLoc.coords.longitude
            );
          }
        } catch (initialErr) {
          // Log a debug warning to the console and allow the technician to continue without visual interruptions
          console.warn('Initial GPS location ping failed:', initialErr);
        }

        if (!isActive) return;

        // Clear any existing active timer before scheduling a new one
        if (locationIntervalRef.current) {
          clearInterval(locationIntervalRef.current);
          locationIntervalRef.current = null;
        }

        // Periodic timer every 10 seconds while EN_ROUTE
        locationIntervalRef.current = setInterval(async () => {
          if (!isActive || job?.status !== 'EN_ROUTE') {
            if (locationIntervalRef.current) {
              clearInterval(locationIntervalRef.current);
              locationIntervalRef.current = null;
            }
            return;
          }
          try {
            const loc = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            });
            if (!isActive) {
              if (locationIntervalRef.current) {
                clearInterval(locationIntervalRef.current);
                locationIntervalRef.current = null;
              }
              return;
            }
            if (loc?.coords) {
              await sendJobLocation(jobId, {
                latitude: loc.coords.latitude,
                longitude: loc.coords.longitude,
                timestamp: Date.now(),
              });
              await evaluateGeofenceAutoArrival(
                loc.coords.latitude,
                loc.coords.longitude
              );
            }
          } catch (err) {
            console.warn('Periodic GPS location ping failed:', err);
          }
        }, 10000);
      } catch (err) {
        console.warn('Failed to start live location tracking:', err);
      }
    };

    if (job?.status === 'EN_ROUTE') {
      startLocationStreaming();
    }

    // When status changes to IN_PROGRESS or COMPLETED (or on unmount),
    // stop the location watcher immediately to preserve battery
    return () => {
      isActive = false;
      if (locationIntervalRef.current) {
        clearInterval(locationIntervalRef.current);
        locationIntervalRef.current = null;
      }
    };
  }, [job?.status, job?.latitude, job?.longitude, jobId]);

  /**
   * Action: Place phone call to customer
   */
  const handleCallCustomer = async () => {
    if (!job?.customerPhone) {
      Alert.alert('Phone Unavailable', 'No phone number on record for this customer.');
      return;
    }

    const cleanPhone = job.customerPhone.replace(/[^\d+]/g, '');
    const url = `tel:${cleanPhone}`;

    try {
      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
      } else {
        Alert.alert(
          'Call Unavailable',
          `Direct calls cannot be placed from this device to ${job.customerPhone}.`
        );
      }
    } catch (err) {
      console.warn('Call error:', err);
      Alert.alert('Error', 'Unable to initiate phone call.');
    }
  };

  /**
   * Action: Navigate to customer site using Google Maps or Apple Maps
   */
  const handleNavigateToSite = async () => {
    if (!job) return;

    const hasCoords = job.latitude != null && job.longitude != null;
    const destCoords = `${job.latitude},${job.longitude}`;
    const destQuery = encodeURIComponent(hasCoords ? destCoords : job.customerAddress);

    const appleUrl = hasCoords
      ? `maps://?ll=${destCoords}&q=${destQuery}`
      : `maps://?q=${destQuery}`;
    const googleAppUrl = hasCoords
      ? `google.navigation:q=${destCoords}`
      : `google.navigation:q=${destQuery}`;
    const webFallbackUrl = `https://www.google.com/maps/dir/?api=1&destination=${destQuery}`;

    try {
      if (Platform.OS === 'ios') {
        const canOpenApple = await Linking.canOpenURL(appleUrl);
        if (canOpenApple) {
          await Linking.openURL(appleUrl);
          return;
        }
      } else if (Platform.OS === 'android') {
        const canOpenGoogle = await Linking.canOpenURL(googleAppUrl);
        if (canOpenGoogle) {
          await Linking.openURL(googleAppUrl);
          return;
        }
      }

      await Linking.openURL(webFallbackUrl);
    } catch (err) {
      console.warn('Navigation launch error:', err);
      try {
        await Linking.openURL(webFallbackUrl);
      } catch {
        Alert.alert('Navigation Error', 'Could not open map application.');
      }
    }
  };

  /**
   * Action: Transition job status (with offline fallback)
   */
  const handleStatusChange = async (newStatus: JobStatus) => {
    setUpdating(true);
    try {
      const result = await updateJob(jobId, { status: newStatus });
      setJob(result.job);

      if (result.queuedOffline) {
        Alert.alert(
          'Saved Locally',
          'Saved locally. Will sync when back online.'
        );
      } else {
        Alert.alert('Status Updated', `Work order is now ${newStatus.replace('_', ' ')}.`);
      }

      if (newStatus === 'IN_PROGRESS' && !beforePhoto && !result.job.beforePhotoUrl) {
        promptBeforePhotoSource();
      }
    } catch (err: any) {
      console.error('Failed to update status:', err);
      Alert.alert('Update Failed', 'Could not update work order status. Please try again.');
    } finally {
      setUpdating(false);
    }
  };

  /**
   * Photo capture helper: Prompt for Camera or Photo Library
   */
  const promptBeforePhotoSource = () => {
    Alert.alert(
      'Before Service Photo',
      'Choose a photo capture source',
      [
        {
          text: 'Take Photo with Camera',
          onPress: () => captureBeforePhoto(true),
        },
        {
          text: 'Choose from Gallery',
          onPress: () => captureBeforePhoto(false),
        },
        {
          text: 'Cancel',
          style: 'cancel',
        },
      ],
      { cancelable: true }
    );
  };

  /**
   * Action: Capture Before Service Photo
   */
  const captureBeforePhoto = async (useCamera: boolean) => {
    try {
      setPhotoUploading(true);
      if (useCamera) {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission Denied', 'Camera permission is required to capture work photos.');
          return;
        }
        const result = await ImagePicker.launchCameraAsync({
          base64: true,
          quality: 0.5,
          allowsEditing: false,
          ...({ maxWidth: 1024, maxHeight: 1024 } as any),
        });
        if (!result.canceled && result.assets && result.assets.length > 0) {
          const asset = result.assets[0];
          const base64Data = asset.base64
            ? `data:image/jpeg;base64,${asset.base64}`
            : asset.uri;
          setBeforePhoto(base64Data);
          await saveBeforePhoto(base64Data);
        }
      } else {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission Denied', 'Photo library permission is required to select photos.');
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          base64: true,
          quality: 0.5,
          allowsEditing: false,
          ...({ maxWidth: 1024, maxHeight: 1024 } as any),
        });
        if (!result.canceled && result.assets && result.assets.length > 0) {
          const asset = result.assets[0];
          const base64Data = asset.base64
            ? `data:image/jpeg;base64,${asset.base64}`
            : asset.uri;
          setBeforePhoto(base64Data);
          await saveBeforePhoto(base64Data);
        }
      }
    } catch (err: any) {
      console.error('Photo capture error:', err);
      Alert.alert('Capture Failed', 'Could not capture photo. Please try again.');
    } finally {
      setPhotoUploading(false);
    }
  };

  const saveBeforePhoto = async (photoUri: string) => {
    try {
      const result = await updateJob(jobId, { beforePhotoUrl: photoUri });
      setJob(result.job);
      if (result.job.beforePhotoUrl) {
        setBeforePhoto(result.job.beforePhotoUrl);
      }
      Alert.alert('Photo Saved', 'Before Service Photo has been recorded.');
    } catch (err) {
      console.error('Failed to save before photo:', err);
      Alert.alert('Save Failed', 'Could not save photo to work order.');
    }
  };

  /**
   * Action: Remove Before Service Photo
   */
  const handleRemoveBeforePhoto = () => {
    Alert.alert(
      'Remove Photo',
      'Are you sure you want to remove the Before Service Photo?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              setPhotoUploading(true);
              setBeforePhoto(null);
              const result = await updateJob(jobId, { beforePhotoUrl: null });
              setJob(result.job);
            } catch (err) {
              console.error('Failed to remove photo:', err);
              Alert.alert('Error', 'Could not remove photo.');
            } finally {
              setPhotoUploading(false);
            }
          },
        },
      ]
    );
  };

  const handleProceedToSign = () => {
    if (!job) return;
    const beforePhotoUri = beforePhoto || job.beforePhotoUrl || null;
    if (!beforePhotoUri) {
      Alert.alert(
        'Pre-Service Photo Required',
        'Capture pre-service photo to proceed with work sign-off.'
      );
      return;
    }
    navigation.navigate('Signature', {
      jobId: job.id,
      customerName: job.customerName,
      jobTitle: job.title,
      beforePhoto: beforePhotoUri,
      beforePhotoUrl: beforePhotoUri,
      laborCost: baseLaborFee,
    });
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={styles.loadingText}>Loading work order details...</Text>
      </View>
    );
  }

  if (error || !job) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={48} color="#EF4444" />
        <Text style={styles.errorText}>{error || 'Job not found'}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={fetchJobDetails}>
          <Text style={styles.retryBtnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isCompleted = job?.status === 'COMPLETED';
  const isInProgress = job.status === 'IN_PROGRESS';
  const hasBeforePhoto = Boolean(beforePhoto || job.beforePhotoUrl);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Global Connectivity Banner / Status Pill */}
      <ConnectivityBanner style={{ marginHorizontal: 0, marginTop: 0, marginBottom: 8 }} />
      {/* Offline Indicator Banner */}
      {isFromCache && (
        <View style={styles.offlineBanner}>
          <Ionicons name="cloud-offline" size={16} color="#B45309" />
          <Text style={styles.offlineBannerText}>
            Offline Mode — Viewing locally cached work order
          </Text>
        </View>
      )}

      {/* 409 Conflict Indicator Banner */}
      {job.conflict === true && (
        <View style={styles.conflictBanner}>
          <Ionicons name="warning" size={18} color="#DC2626" />
          <Text style={styles.conflictBannerText}>
            Sync Conflict (409): This work order was updated on the server while offline. Review before re-submitting.
          </Text>
        </View>
      )}

      {/* Status & Priority Ribbon */}
      <View style={styles.metaHeader}>
        <PriorityBadge priority={job.priority} />
        <StatusBadge status={job.status} size="large" />
      </View>

      {job.status === 'EN_ROUTE' && (
        <View style={styles.liveTrackingPill}>
          <View style={styles.liveTrackingDot} />
          <Text style={styles.liveTrackingText}>
            Live GPS Tracking Active • Broadcasting to Dispatch (10s)
          </Text>
        </View>
      )}

      {/* Active Working Banner when status is IN_PROGRESS */}
      {isInProgress && (
        <View style={styles.activeWorkingBanner}>
          <View style={styles.activeWorkingHeader}>
            <View style={styles.activeWorkingPill}>
              <View style={styles.activePulseDot} />
              <Text style={styles.activeWorkingPillText}>WORK IN PROGRESS</Text>
            </View>
            <Text style={styles.activeWorkingSiteBadge}>On-Site Active</Text>
          </View>
          <Text style={styles.activeWorkingDesc}>
            Technician is performing repair service on-site. Once work is finished, proceed to wrap up materials and collect customer sign-off.
          </Text>
          <TouchableOpacity
            style={[
              styles.activeWorkingFinishBtn,
              !hasBeforePhoto && styles.activeWorkingFinishBtnDisabled,
            ]}
            onPress={handleProceedToSign}
            disabled={!hasBeforePhoto}
            activeOpacity={0.85}
          >
            <Ionicons
              name="checkbox-outline"
              size={20}
              color={!hasBeforePhoto ? '#64748B' : '#FFFFFF'}
            />
            <Text
              style={[
                styles.activeWorkingFinishBtnText,
                !hasBeforePhoto && styles.activeWorkingFinishBtnTextDisabled,
              ]}
            >
              Finish Work & Begin Sign-Off
            </Text>
          </TouchableOpacity>
          {!hasBeforePhoto && (
            <Text style={styles.beforePhotoHintText}>
              Capture pre-service photo to proceed with work sign-off.
            </Text>
          )}
        </View>
      )}

      {/* Main Title & Description */}
      <View style={styles.sectionCard}>
        <Text style={styles.jobTitle}>{job.title}</Text>
        <Text style={styles.jobDesc}>{job.description}</Text>
      </View>

      {/* Customer Info Card & Interactive Actions */}
      <View style={styles.infoCard}>
        <Text style={styles.sectionHeader}>Customer Details</Text>

        <View style={styles.infoRow}>
          <Ionicons name="person-circle-outline" size={20} color="#4B5563" />
          <Text style={styles.infoText}>{job.customerName}</Text>
        </View>

        <View style={styles.infoRow}>
          <Ionicons name="call-outline" size={20} color="#4B5563" />
          <Text style={styles.infoText}>{job.customerPhone}</Text>
        </View>

        <View style={styles.infoRow}>
          <Ionicons name="location-outline" size={20} color="#4B5563" />
          <Text style={styles.infoText}>{job.customerAddress}</Text>
        </View>

        {/* Interactive Call & Map Dispatch Actions */}
        <View style={styles.customerActionRow}>
          <TouchableOpacity
            style={[styles.customerActionBtn, styles.callBtn]}
            onPress={handleCallCustomer}
            activeOpacity={0.7}
          >
            <Ionicons name="call" size={17} color="#FFFFFF" />
            <Text style={styles.customerActionBtnText}>Call Customer</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.customerActionBtn, styles.mapBtn]}
            onPress={handleNavigateToSite}
            activeOpacity={0.7}
          >
            <Ionicons name="navigate" size={17} color="#FFFFFF" />
            <Text style={styles.customerActionBtnText}>Navigate to Site</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Assigned Technician Card */}
      {job.technician && (
        <View style={styles.infoCard}>
          <Text style={styles.sectionHeader}>Assigned Technician</Text>
          <View style={styles.infoRow}>
            <Ionicons name="construct-outline" size={20} color="#4B5563" />
            <Text style={styles.infoText}>{job.technician.name}</Text>
          </View>
          {job.technician.phone && (
            <View style={styles.infoRow}>
              <Ionicons name="phone-portrait-outline" size={20} color="#4B5563" />
              <Text style={styles.infoText}>{job.technician.phone}</Text>
            </View>
          )}
        </View>
      )}

      {/* Proof of Work: Before Service Photo (When IN_PROGRESS or already captured) */}
      {(isInProgress || beforePhoto || job.beforePhotoUrl) && !isCompleted && (
        <View style={[styles.photoSectionCard, isInProgress && !hasBeforePhoto && styles.photoSectionCardHighlight]}>
          <View style={styles.photoSectionHeader}>
            <View style={styles.photoSectionTitleRow}>
              <Ionicons name="camera" size={18} color="#2563EB" />
              <Text style={styles.photoSectionTitle}>Pre-Service Photo</Text>
            </View>
            {hasBeforePhoto ? (
              <View style={styles.photoCapturedBadge}>
                <Ionicons name="checkmark-circle" size={13} color="#059669" />
                <Text style={styles.photoCapturedBadgeText}>Captured</Text>
              </View>
            ) : (
              <View style={styles.photoRequiredBadge}>
                <Text style={styles.photoRequiredBadgeText}>Required</Text>
              </View>
            )}
          </View>
          <Text style={styles.photoSectionSub}>
            Document equipment condition or site setup before commencing service work. Photos are automatically saved to local storage.
          </Text>

          {hasBeforePhoto ? (
            <View style={styles.photoPreviewCard}>
              <View style={styles.imagePreviewContainer}>
                <Image
                  source={{ uri: (beforePhoto || job.beforePhotoUrl) as string }}
                  style={{ width: '100%', height: '100%' }}
                  resizeMode="cover"
                />
              </View>
              <View style={styles.photoActionRow}>
                <TouchableOpacity
                  style={[styles.photoBtn, styles.photoRetakeBtn]}
                  onPress={promptBeforePhotoSource}
                  disabled={photoUploading}
                  activeOpacity={0.7}
                >
                  <Ionicons name="camera-reverse-outline" size={16} color="#2563EB" />
                  <Text style={styles.photoRetakeText}>Retake Photo</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.photoBtn, styles.photoRemoveBtn]}
                  onPress={handleRemoveBeforePhoto}
                  disabled={photoUploading}
                  activeOpacity={0.7}
                >
                  <Ionicons name="trash-outline" size={16} color="#EF4444" />
                  <Text style={styles.photoRemoveText}>Remove</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.photoPlaceholderBtn, styles.photoPlaceholderHighlight]}
              onPress={promptBeforePhotoSource}
              disabled={photoUploading}
              activeOpacity={0.7}
            >
              {photoUploading ? (
                <View style={styles.photoPlaceholderContent}>
                  <ActivityIndicator size="small" color="#2563EB" />
                  <Text style={styles.photoPlaceholderTitle}>Processing Photo...</Text>
                </View>
              ) : (
                <View style={styles.photoPlaceholderContent}>
                  <View style={styles.photoIconCircle}>
                    <Ionicons name="camera" size={24} color="#2563EB" />
                  </View>
                  <Text style={styles.photoPlaceholderTitle}>Tap to take pre-service photo</Text>
                  <Text style={styles.photoPlaceholderSub}>
                    Use camera or select from photo library
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Completed Job Artifacts */}
      {isCompleted && (
        <View style={styles.completionCard}>
          <View style={styles.completionHeader}>
            <Ionicons name="checkmark-circle" size={24} color="#10B981" />
            <Text style={styles.completionTitle}>Work Order Completed</Text>
          </View>

          {job.completedAt && (
            <Text style={styles.completedTimestamp}>
              Closed on: {new Date(job.completedAt).toLocaleString()}
            </Text>
          )}

          {job.completionNotes && (
            <View style={styles.notesContainer}>
              <Text style={styles.notesLabel}>Technician Completion Notes:</Text>
              <Text style={styles.notesBody}>{job.completionNotes}</Text>
            </View>
          )}

          {/* Proof of Work Photos in Completed Card */}
          {(() => {
            const rawBefore =
              job.beforePhotoUrl ||
              (job as any).beforePhoto ||
              (job as any).beforePhotoUri ||
              (job as any).before_photo_url;
            const rawAfter =
              job.afterPhotoUrl ||
              (job as any).afterPhoto ||
              (job as any).afterPhotoUri ||
              (job as any).after_photo_url;

            const resolvedBefore = normalizePhotoUri(rawBefore);
            const resolvedAfter = normalizePhotoUri(rawAfter);

            if (!resolvedBefore && !resolvedAfter) return null;

            return (
              <View style={styles.proofPhotosSection}>
                <Text style={styles.proofPhotosTitle}>Proof of Work Photos</Text>
                <View style={styles.proofPhotosGrid}>
                  {resolvedBefore ? (
                    <View style={styles.proofPhotoCol}>
                      <Text style={styles.proofPhotoLabel}>Before Service</Text>
                      <Image
                        source={{ uri: resolvedBefore }}
                        style={styles.proofPhotoImg}
                        resizeMode="cover"
                      />
                    </View>
                  ) : null}
                  {resolvedAfter ? (
                    <View style={styles.proofPhotoCol}>
                      <Text style={styles.proofPhotoLabel}>After Service</Text>
                      <Image
                        source={{ uri: resolvedAfter }}
                        style={styles.proofPhotoImg}
                        resizeMode="cover"
                      />
                    </View>
                  ) : null}
                </View>
              </View>
            );
          })()}

          {/* Materials Used in Completed Card */}
          {Boolean(job.materialsUsed) && (
            <View style={{ marginTop: 14, backgroundColor: '#F8FAFC', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: '#E2E8F0' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <Ionicons name="construct" size={16} color="#059669" />
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#1E293B' }}>Materials & Replacement Parts</Text>
              </View>
              {(() => {
                let list: any[] = [];
                try {
                  list = typeof job.materialsUsed === 'string' ? JSON.parse(job.materialsUsed) : ((job.materialsUsed as any) || []);
                } catch {
                  list = [];
                }
                const totalCost = list.reduce((sum, i) => sum + (i.totalCost || i.unitCost * i.quantity || 0), 0);
                return (
                  <View style={{ gap: 6 }}>
                    {list.map((m, idx) => (
                      <View key={idx} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={{ fontSize: 12, color: '#334155', flex: 1 }}>{m.name} (x{m.quantity})</Text>
                        <Text style={{ fontSize: 12, fontWeight: '700', color: '#059669' }}>${Number(m.totalCost || m.unitCost * m.quantity || 0).toFixed(2)}</Text>
                      </View>
                    ))}
                    <View style={{ borderTopWidth: 1, borderTopColor: '#CBD5E1', paddingTop: 6, marginTop: 4, flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#0F172A' }}>Total Materials:</Text>
                      <Text style={{ fontSize: 13, fontWeight: '800', color: '#059669' }}>${totalCost.toFixed(2)}</Text>
                    </View>
                  </View>
                );
              })()}
            </View>
          )}

          {/* Financial Settlement Breakdown */}
          <View style={{ marginTop: 14, backgroundColor: '#F0FDF4', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: '#BBF7D0' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="card" size={16} color="#059669" />
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#065F46' }}>Payment & Financial Settlement</Text>
              </View>
              <View style={{ backgroundColor: '#DCFCE7', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, borderWidth: 1, borderColor: '#86EFAC' }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#15803D' }}>
                  {job.paymentStatus === 'PAID' ? '🟢 PAID' : '🟡 UNPAID'}
                </Text>
              </View>
            </View>

            <View style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 12, color: '#475569' }}>Base Labor Fee:</Text>
                <Text style={{ fontSize: 12, fontWeight: '600', color: '#1E293B' }}>${baseLaborFee.toFixed(2)}</Text>
              </View>

              {(() => {
                let partsList: any[] = [];
                try {
                  partsList = typeof job.materialsUsed === 'string' ? JSON.parse(job.materialsUsed) : ((job.materialsUsed as any) || []);
                } catch {
                  partsList = [];
                }
                const partsCost = partsList.reduce((sum, i) => sum + (Number(i.totalCost) || (Number(i.unitCost || 0) * Number(i.quantity || 1)) || 0), 0);
                if (partsList.length === 0) return null;
                return (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: '#475569' }}>Truck Parts ({partsList.length} items):</Text>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: '#1E293B' }}>${partsCost.toFixed(2)}</Text>
                  </View>
                );
              })()}

              {(() => {
                let customList: any[] = [];
                try {
                  customList = typeof job.customServices === 'string' ? JSON.parse(job.customServices) : ((job.customServices as any) || []);
                } catch {
                  customList = [];
                }
                const customCost = customList.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
                if (customList.length === 0) return null;
                return (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: '#475569' }}>Custom Repairs ({customList.length} items):</Text>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: '#7C3AED' }}>${customCost.toFixed(2)}</Text>
                  </View>
                );
              })()}

              <View style={{ borderTopWidth: 1, borderTopColor: '#86EFAC', paddingTop: 6, marginTop: 4, flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#065F46' }}>Total Amount Paid:</Text>
                <Text style={{ fontSize: 14, fontWeight: '800', color: '#059669' }}>${Number(typeof job.totalAmount === 'number' ? job.totalAmount : baseLaborFee).toFixed(2)}</Text>
              </View>

              <View style={{ marginTop: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: '#DCFCE7' }}>
                <Text style={{ fontSize: 11, color: '#047857' }}>
                  Method: {job.paymentMethod === 'ONLINE_TRANSFER' ? 'Direct Bank / Digital Transfer' : 'Cash Collected on Site'}
                  {job.paymentNotes ? ` • Ref: ${job.paymentNotes}` : ''}
                </Text>
              </View>
            </View>
          </View>

          {job.signatureData && (
            <View style={styles.signatureBadgeRow}>
              <Ionicons name="shield-checkmark" size={18} color="#059669" />
              <Text style={styles.signatureBadgeText}>Customer Signature Confirmed & Recorded</Text>
            </View>
          )}
        </View>
      )}

      {/* Action Workflow Section */}
      {!isCompleted && (
        <View style={styles.actionSection}>
          <Text style={styles.sectionHeader}>Dispatch Actions</Text>

          {updating ? (
            <ActivityIndicator size="small" color="#2563EB" />
          ) : (
            <View style={styles.buttonStack}>
              {/* Prominent Completion & Signature Button when status reaches IN_PROGRESS */}
              {isInProgress && (
                <View style={{ gap: 6 }}>
                  <TouchableOpacity
                    style={[
                      styles.actionBtn,
                      styles.btnProminentSign,
                      !hasBeforePhoto && styles.btnProminentSignDisabled,
                    ]}
                    onPress={handleProceedToSign}
                    disabled={!hasBeforePhoto}
                    activeOpacity={0.85}
                  >
                    <Ionicons
                      name="document-text"
                      size={22}
                      color={!hasBeforePhoto ? '#64748B' : '#FFFFFF'}
                    />
                    <Text
                      style={[
                        styles.btnProminentText,
                        !hasBeforePhoto && styles.btnProminentTextDisabled,
                      ]}
                    >
                      Finish Work & Begin Sign-Off
                    </Text>
                  </TouchableOpacity>
                  {!hasBeforePhoto && (
                    <Text style={styles.beforePhotoHintText}>
                      Capture pre-service photo to proceed with work sign-off.
                    </Text>
                  )}
                </View>
              )}

              {/* Status transition to En Route */}
              {job.status === 'PENDING' && (
                <TouchableOpacity
                  style={[styles.actionBtn, styles.btnEnRoute]}
                  onPress={() => handleStatusChange('EN_ROUTE')}
                  activeOpacity={0.8}
                >
                  <Ionicons name="car-outline" size={20} color="#FFFFFF" />
                  <Text style={styles.btnText}>Mark En Route</Text>
                </TouchableOpacity>
              )}

              {/* Status transition to In Progress */}
              {job.status === 'EN_ROUTE' && (
                <TouchableOpacity
                  style={[styles.actionBtn, styles.btnStart]}
                  onPress={() => handleStatusChange('IN_PROGRESS')}
                  activeOpacity={0.8}
                >
                  <Ionicons name="hammer-outline" size={20} color="#FFFFFF" />
                  <Text style={styles.btnText}>Start Work Order</Text>
                </TouchableOpacity>
              )}

              {/* Direct fast-track start */}
              {job.status === 'PENDING' && (
                <TouchableOpacity
                  style={[styles.actionBtn, styles.btnSecondary]}
                  onPress={() => handleStatusChange('IN_PROGRESS')}
                  activeOpacity={0.8}
                >
                  <Ionicons name="play-outline" size={18} color="#2563EB" />
                  <Text style={styles.btnSecondaryText}>Direct Start Job</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  content: {
    padding: 18,
    gap: 16,
    paddingBottom: 40,
  },
  offlineBanner: {
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  offlineBannerText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#92400E',
    flexShrink: 1,
  },
  conflictBanner: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  conflictBannerText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#991B1B',
    flexShrink: 1,
  },
  metaHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  liveTrackingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  liveTrackingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10B981',
    marginRight: 8,
  },
  liveTrackingText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#065F46',
  },
  sectionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  jobTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#111827',
    marginBottom: 8,
  },
  jobDesc: {
    fontSize: 15,
    color: '#4B5563',
    lineHeight: 22,
  },
  infoCard: {
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 12,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  infoText: {
    fontSize: 15,
    color: '#1F2937',
    fontWeight: '500',
    flexShrink: 1,
  },
  customerActionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  customerActionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    gap: 8,
  },
  callBtn: {
    backgroundColor: '#0284C7',
  },
  mapBtn: {
    backgroundColor: '#4F46E5',
  },
  customerActionBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  completionCard: {
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
    borderWidth: 1,
    borderRadius: 14,
    padding: 18,
    gap: 10,
  },
  completionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  completionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#065F46',
  },
  completedTimestamp: {
    fontSize: 13,
    color: '#047857',
  },
  notesContainer: {
    marginTop: 6,
    backgroundColor: '#FFFFFF',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1FAE5',
  },
  notesLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#047857',
    marginBottom: 4,
  },
  notesBody: {
    fontSize: 14,
    color: '#1F2937',
    lineHeight: 20,
  },
  signatureBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  signatureBadgeText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#047857',
  },
  actionSection: {
    gap: 12,
    marginTop: 8,
  },
  buttonStack: {
    gap: 12,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 15,
    borderRadius: 12,
    gap: 8,
  },
  btnProminentSign: {
    backgroundColor: '#059669',
    paddingVertical: 17,
    elevation: 3,
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 5,
  },
  btnProminentText: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 16,
  },
  btnEnRoute: {
    backgroundColor: '#8B5CF6',
  },
  btnStart: {
    backgroundColor: '#3B82F6',
  },
  btnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 16,
  },
  btnSecondary: {
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  btnSecondaryText: {
    color: '#2563EB',
    fontWeight: '700',
    fontSize: 15,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#6B7280',
  },
  errorText: {
    marginTop: 12,
    fontSize: 14,
    color: '#EF4444',
    textAlign: 'center',
    marginBottom: 16,
  },
  retryBtn: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryBtnText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  photoSectionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    gap: 12,
  },
  photoSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  photoSectionTitleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginRight: 8,
  },
  photoSectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#111827',
  },
  photoCapturedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#ECFDF5',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#A7F3D0',
    flexShrink: 0,
  },
  photoCapturedBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#059669',
  },
  photoSectionSub: {
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 18,
  },
  photoPreviewCard: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  imagePreviewContainer: {
    width: '100%',
    height: 200,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#E5E7EB',
  },
  imagePreview: {
    width: '100%',
    height: '100%',
  },
  photoActionRow: {
    flexDirection: 'row',
    padding: 10,
    backgroundColor: '#FFFFFF',
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  photoBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    borderRadius: 8,
    gap: 6,
  },
  photoRetakeBtn: {
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  photoRetakeText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#2563EB',
  },
  photoRemoveBtn: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  photoRemoveText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#EF4444',
  },
  photoPlaceholderBtn: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#BFDBFE',
    backgroundColor: '#F8FAFF',
    borderRadius: 12,
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoPlaceholderContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#EFF6FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  photoPlaceholderTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#2563EB',
  },
  photoPlaceholderSub: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  proofPhotosSection: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#D1FAE5',
  },
  proofPhotosTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#065F46',
    marginBottom: 8,
  },
  proofPhotosGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  proofPhotoCol: {
    flex: 1,
    gap: 4,
  },
  proofPhotoLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#047857',
  },
  proofPhotoImg: {
    width: '100%',
    height: 100,
    borderRadius: 8,
    backgroundColor: '#E5E7EB',
  },
  activeWorkingBanner: {
    backgroundColor: '#EFF6FF',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1.5,
    borderColor: '#3B82F6',
    gap: 10,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  activeWorkingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  activeWorkingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#DBEAFE',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  activePulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#2563EB',
    marginRight: 6,
  },
  activeWorkingPillText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#1D4ED8',
    letterSpacing: 0.5,
  },
  activeWorkingSiteBadge: {
    fontSize: 12,
    fontWeight: '600',
    color: '#3B82F6',
  },
  activeWorkingDesc: {
    fontSize: 13,
    color: '#1E3A8A',
    lineHeight: 18,
  },
  activeWorkingFinishBtn: {
    backgroundColor: '#059669',
    borderRadius: 10,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 5,
    elevation: 3,
  },
  activeWorkingFinishBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  activeWorkingFinishBtnDisabled: {
    backgroundColor: '#E2E8F0',
    shadowOpacity: 0,
    elevation: 0,
  },
  activeWorkingFinishBtnTextDisabled: {
    color: '#94A3B8',
  },
  btnProminentSignDisabled: {
    backgroundColor: '#E2E8F0',
    shadowOpacity: 0,
    elevation: 0,
  },
  btnProminentTextDisabled: {
    color: '#94A3B8',
  },
  beforePhotoHintText: {
    textAlign: 'center',
    fontSize: 12,
    color: '#D97706',
    fontWeight: '600',
    marginTop: 6,
  },
  photoSectionCardHighlight: {
    borderColor: '#3B82F6',
    borderWidth: 1.5,
    backgroundColor: '#F8FAFF',
  },
  photoRequiredBadge: {
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#FDE68A',
    flexShrink: 0,
  },
  photoRequiredBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#92400E',
  },
  photoPlaceholderHighlight: {
    borderColor: '#3B82F6',
    backgroundColor: '#FFFFFF',
  },
});
