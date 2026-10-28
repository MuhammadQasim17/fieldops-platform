import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Platform,
} from 'react-native';
import Svg, { Path, Text as SvgText } from 'react-native-svg';
import { RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RootStackParamList, InventoryItem, MaterialUsed, CustomService } from '../types';
import { updateJob, getInventory, updateCachedJobLocally, getSystemSettings, getJobById, SystemSettings } from '../services/api';
import { getCachedJobById } from '../services/storage';

type SignatureRouteProp = RouteProp<RootStackParamList, 'Signature'>;
type SignatureNavProp = NativeStackNavigationProp<RootStackParamList, 'Signature'>;

type WorkflowStage = 'WRAP_UP' | 'SIGNATURE' | 'CONFIRMATION';

const WINDOW_HEIGHT = Dimensions.get('window').height;
const WINDOW_WIDTH = Dimensions.get('window').width;

// Dynamically Scaled & Optimized Signature Pad dimensions (expanded by 40-50px to eliminate dead whitespace)
const SIGNATURE_PAD_WIDTH = Math.max(300, WINDOW_WIDTH - 32);
const SIGNATURE_PAD_HEIGHT = Math.min(430, Math.max(300, Math.round(WINDOW_HEIGHT * 0.55)));

export const SignatureScreen: React.FC = () => {
  const insets = useSafeAreaInsets();
  const route = useRoute<SignatureRouteProp>();
  const navigation = useNavigation<SignatureNavProp>();
  const {
    jobId,
    customerName = 'Customer',
    jobTitle = 'Work Order',
  } = (route.params || {}) as any;

  // Staged execution state
  const [currentStep, setCurrentStep] = useState<WorkflowStage>('WRAP_UP');

  // Photo state
  const routeBeforePhoto = route.params?.beforePhoto || (route.params as any)?.beforePhotoUrl;
  const [beforePhoto, setBeforePhoto] = useState<string | null>(routeBeforePhoto || null);
  const [afterPhoto, setAfterPhoto] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);

  useEffect(() => {
    if (route.params?.beforePhoto) {
      setBeforePhoto(route.params.beforePhoto);
    } else if ((route.params as any)?.beforePhotoUrl) {
      setBeforePhoto((route.params as any).beforePhotoUrl);
    }
  }, [route.params?.beforePhoto, (route.params as any)?.beforePhotoUrl]);

  // Progressive reveal & Keyboard listener state
  const [materialsChoiceMade, setMaterialsChoiceMade] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => {
        setKeyboardHeight(e.endCoordinates.height);
      }
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setKeyboardHeight(0);
      }
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Parts & Materials Inventory state
  const [availableInventory, setAvailableInventory] = useState<InventoryItem[]>([]);
  const [loadingInventory, setLoadingInventory] = useState(false);
  const [selectedMaterials, setSelectedMaterials] = useState<MaterialUsed[]>([]);
  const [partSearchQuery, setPartSearchQuery] = useState('');
  const [showPartPicker, setShowPartPicker] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const fetchParts = async () => {
      setLoadingInventory(true);
      try {
        const items = await getInventory();
        if (isMounted && Array.isArray(items)) {
          setAvailableInventory(items);
        }
      } catch (err) {
        console.warn('Could not load inventory:', err);
      } finally {
        if (isMounted) setLoadingInventory(false);
      }
    };
    fetchParts();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleConfirmStandardLabor = () => {
    setMaterialsChoiceMade(true);
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 250);
  };

  const getItemRemainingStock = (item: InventoryItem) => {
    const originalStock =
      typeof item.quantityInStock === 'number'
        ? item.quantityInStock
        : typeof item.stockQty === 'number'
        ? item.stockQty
        : 0;
    const selected = selectedMaterials.find((m) => m.itemId === item.id);
    const selectedQty = selected ? selected.quantity : 0;
    return Math.max(0, originalStock - selectedQty);
  };

  const handleAddPart = (item: InventoryItem) => {
    const originalStock =
      typeof item.quantityInStock === 'number'
        ? item.quantityInStock
        : typeof item.stockQty === 'number'
        ? item.stockQty
        : 0;
    const existing = selectedMaterials.find((m) => m.itemId === item.id);
    const currentQty = existing ? existing.quantity : 0;

    if (currentQty >= originalStock) {
      Alert.alert(
        'Stock Limit Reached',
        `Cannot add more than available stock (${originalStock} in stock).`
      );
      return;
    }

    setMaterialsChoiceMade(true);
    setSelectedMaterials((prev) => {
      const existingIndex = prev.findIndex((m) => m.itemId === item.id);
      if (existingIndex >= 0) {
        const updated = [...prev];
        const newQty = updated[existingIndex].quantity + 1;
        updated[existingIndex] = {
          ...updated[existingIndex],
          quantity: newQty,
          totalCost: Number((updated[existingIndex].unitCost * newQty).toFixed(2)),
        };
        return updated;
      } else {
        return [
          ...prev,
          {
            itemId: item.id,
            name: item.name,
            sku: item.sku,
            unitCost: item.unitCost,
            quantity: 1,
            totalCost: Number(item.unitCost.toFixed(2)),
            category: item.category,
          },
        ];
      }
    });
    setPartSearchQuery('');
    setShowPartPicker(false);
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 250);
  };

  const handleUpdateQuantity = (itemId: string, delta: number) => {
    if (delta > 0) {
      const invItem = availableInventory.find((i) => i.id === itemId);
      const existing = selectedMaterials.find((m) => m.itemId === itemId);
      if (invItem && existing) {
        const originalStock =
          typeof invItem.quantityInStock === 'number'
            ? invItem.quantityInStock
            : typeof invItem.stockQty === 'number'
            ? invItem.stockQty
            : 0;
        if (existing.quantity + delta > originalStock) {
          Alert.alert(
            'Stock Limit Reached',
            `Cannot exceed available stock (${originalStock} in stock).`
          );
          return;
        }
      }
    }

    setSelectedMaterials((prev) => {
      return prev
        .map((m) => {
          if (m.itemId === itemId) {
            const newQty = m.quantity + delta;
            if (newQty <= 0) return null;
            return {
              ...m,
              quantity: newQty,
              totalCost: Number((m.unitCost * newQty).toFixed(2)),
            };
          }
          return m;
        })
        .filter(Boolean) as MaterialUsed[];
    });
  };

  const handleRemovePart = (itemId: string) => {
    setSelectedMaterials((prev) => prev.filter((m) => m.itemId !== itemId));
  };

  const totalMaterialsCost = selectedMaterials.reduce(
    (sum, m) => sum + (m.totalCost || m.unitCost * m.quantity),
    0
  );

  // Custom Repair / Other Services state
  const [customServices, setCustomServices] = useState<Array<{ id: string; description: string; amount: number }>>([]);
  const [showCustomServiceInput, setShowCustomServiceInput] = useState(false);
  const [customDescription, setCustomDescription] = useState('');
  const [customAmount, setCustomAmount] = useState('');

  const hasMaterialsChoice =
    materialsChoiceMade || selectedMaterials.length > 0 || customServices.length > 0;

  const handleAddCustomService = () => {
    const desc = customDescription.trim();
    const amt = parseFloat(customAmount);
    if (!desc) {
      Alert.alert('Description Required', 'Please enter a description of the work performed (e.g., Wire Soldering, Diagnostic, Component Repair).');
      return;
    }
    if (isNaN(amt) || amt < 0) {
      Alert.alert('Valid Amount Required', 'Please enter a valid dollar amount (e.g., 25.00).');
      return;
    }
    setCustomServices((prev) => [
      ...prev,
      {
        id: `custom-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        description: desc,
        amount: Number(amt.toFixed(2)),
      },
    ]);
    setCustomDescription('');
    setCustomAmount('');
    setShowCustomServiceInput(false);
    setMaterialsChoiceMade(true);
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 250);
  };

  const handleRemoveCustomService = (id: string) => {
    setCustomServices((prev) => prev.filter((s) => s.id !== id));
  };

  // Base Labor & Running Bill Calculations
  const [job, setJob] = useState<any>(() => {
    const p = (route.params || {}) as any;
    return {
      id: p.jobId,
      laborCost: typeof p.laborCost === 'number' ? p.laborCost : undefined,
    };
  });
  const [systemSettings, setSystemSettings] = useState<SystemSettings | null>(null);

  useEffect(() => {
    getSystemSettings()
      .then((settings) => {
        if (settings) setSystemSettings(settings);
      })
      .catch(() => {});

    if (jobId) {
      getCachedJobById(jobId)
        .then((j: any) => {
          if (j) setJob((prev: any) => ({ ...prev, ...j }));
        })
        .catch(() => {});

      getJobById(jobId)
        .then((res: any) => {
          if (res?.job) setJob((prev: any) => ({ ...prev, ...res.job }));
        })
        .catch(() => {});
    }
  }, [jobId]);

  const baseLaborFee = typeof job?.laborCost === 'number' && job.laborCost >= 0 
    ? job.laborCost 
    : (systemSettings?.defaultBaseLaborFee ?? (job?.laborCost ?? 0));

  const BASE_LABOR_FEE = baseLaborFee;
  const truckPartsTotal = totalMaterialsCost;
  const customServicesTotal = customServices.reduce(
    (sum, s) => sum + (Number(s.amount) || 0),
    0
  );
  const totalCustomServicesCost = customServicesTotal;
  const totalBill = Number(
    (baseLaborFee + truckPartsTotal + customServicesTotal).toFixed(2)
  );

  // Mandatory On-Spot Payment Collection State
  type PaymentMethodType = 'CASH_ON_SITE' | 'ONLINE_TRANSFER';
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodType | null>(null);
  const [paymentRefNumber, setPaymentRefNumber] = useState('');

  const filteredInventory = availableInventory.filter((item) => {
    if (!partSearchQuery.trim()) return true;
    const q = partSearchQuery.toLowerCase();
    return (
      item.name.toLowerCase().includes(q) ||
      item.sku.toLowerCase().includes(q) ||
      (item.category && item.category.toLowerCase().includes(q))
    );
  });

  // Photo capture handler
  const promptPhotoSource = (target: 'before' | 'after') => {
    const title = target === 'before' ? 'Before Service Photo' : 'After Service Photo';
    Alert.alert(
      title,
      'Select a photo capture source',
      [
        {
          text: 'Take Photo with Camera',
          onPress: () => capturePhoto(target, true),
        },
        {
          text: 'Choose from Gallery',
          onPress: () => capturePhoto(target, false),
        },
        {
          text: 'Cancel',
          style: 'cancel',
        },
      ],
      { cancelable: true }
    );
  };

  const capturePhoto = async (target: 'before' | 'after', useCamera: boolean) => {
    try {
      setPhotoUploading(true);
      if (useCamera) {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission Denied', 'Camera permission is required to take service photos.');
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
          if (target === 'before') {
            setBeforePhoto(base64Data);
          } else {
            setAfterPhoto(base64Data);
            setTimeout(() => {
              scrollViewRef.current?.scrollTo({ y: 360, animated: true });
            }, 300);
          }
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
          if (target === 'before') {
            setBeforePhoto(base64Data);
          } else {
            setAfterPhoto(base64Data);
            setTimeout(() => {
              scrollViewRef.current?.scrollTo({ y: 360, animated: true });
            }, 300);
          }
        }
      }
    } catch (err) {
      console.error('Photo capture error:', err);
      Alert.alert('Error', 'Unable to capture photo. Please try again.');
    } finally {
      setPhotoUploading(false);
    }
  };

  // Dedicated Signature Pad & Touch Points Smoothing
  const [paths, setPaths] = useState<string[]>([]);
  const [currentPath, setCurrentPath] = useState<string>('');
  const currentPathRef = useRef<string>('');
  const pointsRef = useRef<{ x: number; y: number }[]>([]);
  const [signatureError, setSignatureError] = useState<string | null>(null);

  // PanResponder with Quadratic Bézier Curve Smoothing:
  // path += ` Q ${prevX} ${prevY}, ${(prevX + curX) / 2} ${(prevY + curY) / 2}`
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,

      onPanResponderGrant: (evt) => {
        setSignatureError(null);
        const { locationX, locationY } = evt.nativeEvent;
        const x = Math.max(0, Math.min(SIGNATURE_PAD_WIDTH, Number(locationX.toFixed(1))));
        const y = Math.max(0, Math.min(SIGNATURE_PAD_HEIGHT, Number(locationY.toFixed(1))));

        pointsRef.current = [{ x, y }];
        const startCmd = `M ${x} ${y}`;
        currentPathRef.current = startCmd;
        setCurrentPath(startCmd);
      },

      onPanResponderMove: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        const curX = Math.max(0, Math.min(SIGNATURE_PAD_WIDTH, Number(locationX.toFixed(1))));
        const curY = Math.max(0, Math.min(SIGNATURE_PAD_HEIGHT, Number(locationY.toFixed(1))));

        const pts = pointsRef.current;
        if (pts.length === 0) {
          pointsRef.current = [{ x: curX, y: curY }];
          const startCmd = `M ${curX} ${curY}`;
          currentPathRef.current = startCmd;
          setCurrentPath(startCmd);
          return;
        }

        const prevPt = pts[pts.length - 1];
        const distSq = (curX - prevPt.x) ** 2 + (curY - prevPt.y) ** 2;
        if (distSq < 2) return;

        pts.push({ x: curX, y: curY });

        // Quadratic Bézier Curve smoothing for ultra-smooth touch response:
        const prevX = prevPt.x;
        const prevY = prevPt.y;
        const midX = Number(((prevX + curX) / 2).toFixed(1));
        const midY = Number(((prevY + curY) / 2).toFixed(1));
        const curveSegment = ` Q ${prevX} ${prevY}, ${midX} ${midY}`;

        currentPathRef.current += curveSegment;
        setCurrentPath(currentPathRef.current);
      },

      onPanResponderRelease: () => {
        const pts = pointsRef.current;
        if (pts.length > 1) {
          const last = pts[pts.length - 1];
          const finalStroke = currentPathRef.current + ` L ${last.x} ${last.y}`;
          setPaths((prev) => [...prev, finalStroke]);
          setSignatureError(null);
        } else if (pts.length === 1) {
          const p = pts[0];
          const dot = `M ${p.x} ${p.y} L ${(p.x + 0.5).toFixed(1)} ${(p.y + 0.5).toFixed(1)}`;
          setPaths((prev) => [...prev, dot]);
          setSignatureError(null);
        }
        pointsRef.current = [];
        currentPathRef.current = '';
        setCurrentPath('');
      },

      onPanResponderTerminate: () => {
        pointsRef.current = [];
        currentPathRef.current = '';
        setCurrentPath('');
      },
    })
  ).current;

  const handleClearSignature = () => {
    pointsRef.current = [];
    currentPathRef.current = '';
    setCurrentPath('');
    setPaths([]);
    setSignatureError(null);
  };

  const [isNotesFocused, setIsNotesFocused] = useState(false);

  const handleAcceptSignature = () => {
    const allPaths = [...paths];
    if (currentPath && !allPaths.includes(currentPath)) {
      allPaths.push(currentPath);
    }
    if (allPaths.length === 0) {
      const msg = 'Customer signature is required before proceeding.';
      setSignatureError(msg);
      Alert.alert('Signature Required', msg);
      return;
    }
    setSignatureError(null);
    setCurrentStep('CONFIRMATION');
    setTimeout(() => {
      confirmationScrollRef.current?.scrollToEnd({ animated: true });
      notesInputRef.current?.focus();
      setIsNotesFocused(true);
    }, 300);
  };

  useEffect(() => {
    if (currentStep === 'CONFIRMATION') {
      const timer = setTimeout(() => {
        confirmationScrollRef.current?.scrollToEnd({ animated: true });
        notesInputRef.current?.focus();
        setIsNotesFocused(true);
      }, 350);
      return () => clearTimeout(timer);
    }
  }, [currentStep]);

  // Stage 4: Technician completion notes & final submission
  const [completionNotes, setCompletionNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [isCompletedSuccess, setIsCompletedSuccess] = useState(false);
  const [completionModalVisible, setCompletionModalVisible] = useState(false);
  const [completionModalData, setCompletionModalData] = useState<{
    title: string;
    message: string;
    locationNotice: string;
  } | null>(null);

  const confirmationScrollRef = useRef<ScrollView>(null);
  const notesInputRef = useRef<TextInput>(null);
  const scrollViewRef = useRef<ScrollView>(null);

  const handleReturnToJobs = () => {
    setCompletionModalVisible(false);
    navigation.reset({
      index: 0,
      routes: [{ name: 'JobList' }],
    });
  };

  const handleCompleteJob = async () => {
    setSubmitAttempted(true);

    if (completionNotes.trim().length < 5) {
      Alert.alert(
        'Notes Required',
        'Please enter at least 5 characters of technician work completion notes before finalizing.'
      );
      return;
    }

    const allPaths = [...paths];
    if (currentPath && !allPaths.includes(currentPath)) {
      allPaths.push(currentPath);
    }
    if (allPaths.length === 0) {
      Alert.alert('Signature Required', 'Customer signature is required to complete this job.');
      setCurrentStep('SIGNATURE');
      return;
    }

    setSubmitting(true);

    // Fast non-blocking GPS capture attempt (with timeout so UI never hangs)
    let capturedLatitude: number | null = null;
    let capturedLongitude: number | null = null;
    try {
      let loc = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
      ]);

      // Fallback to last known position if real-time satellite fix is delayed
      if (!loc) {
        loc = await Location.getLastKnownPositionAsync();
      }

      if (loc && 'coords' in (loc as any)) {
        capturedLatitude = (loc as any).coords.latitude;
        capturedLongitude = (loc as any).coords.longitude;
      }
    } catch (locErr) {
      console.warn('GPS location capture non-blocking warning:', locErr);
    }

    try {
      const combinedPath = allPaths.join(' ');
      const signatureDataUri = `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIGNATURE_PAD_WIDTH} ${SIGNATURE_PAD_HEIGHT}"><path d="${combinedPath}" stroke="#0F172A" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      )}`;

      const finalNotes = completionNotes.trim();
      const finalPaymentNotes =
        paymentMethod === 'ONLINE_TRANSFER' && paymentRefNumber.trim()
          ? paymentRefNumber.trim()
          : (paymentMethod === 'CASH_ON_SITE' ? 'Cash collected on-site by technician' : null);

      const completedAtTimestamp = new Date().toISOString();
      const completionPayload = {
        status: 'COMPLETED' as const,
        completionNotes: finalNotes,
        notes: finalNotes,
        signatureData: signatureDataUri,
        signatureSvg: combinedPath,
        completedLatitude: capturedLatitude,
        completedLongitude: capturedLongitude,
        latitude: capturedLatitude,
        longitude: capturedLongitude,
        beforePhoto: beforePhoto,
        beforePhotoUrl: beforePhoto,
        afterPhoto: afterPhoto,
        afterPhotoUrl: afterPhoto,
        materialsUsed: selectedMaterials,
        laborCost: baseLaborFee,
        customServices: customServices.map((s) => ({ description: s.description, amount: s.amount })),
        totalAmount: totalBill,
        paymentStatus: 'PAID',
        paymentMethod: paymentMethod || 'CASH_ON_SITE',
        paymentNotes: finalPaymentNotes,
        completedAt: completedAtTimestamp,
        is_synced: true,
        pending_sync: false,
      };

      // 1. Immediately mark local job in memory and local SQLite/AsyncStorage cache as COMPLETED & PAID
      setJob((prev: any) => ({ ...prev, ...completionPayload }));
      await updateCachedJobLocally(jobId, completionPayload).catch((err) => {
        console.warn('Optimistic local storage completion update warning:', err);
      });

      // 2. Wait for the API update / sync call to resolve so photos, signature, and completion email push reliably!
      try {
        await updateJob(jobId, completionPayload);
      } catch (syncErr) {
        console.warn('Network sync notice (queued offline):', syncErr);
      } finally {
        // 3. Switch screen to completion confirmation state ("Work Order Completed!")
        setSubmitting(false);
        setIsCompletedSuccess(true);
      }
    } catch (err: any) {
      console.error('Failed to submit completion:', err);
      Alert.alert('Submission Error', 'Failed to save completion sign-off. Please try again.');
      setSubmitting(false);
    }
  };

  // Step indicator banner
  const renderStepIndicator = () => (
    <View style={styles.stickyStepperBar}>
      <View style={styles.progressStepperContainer}>
        <TouchableOpacity
          style={[styles.stepTab, currentStep === 'WRAP_UP' && styles.stepTabActive]}
          onPress={() => setCurrentStep('WRAP_UP')}
          activeOpacity={0.7}
        >
          <View style={[styles.stepNumberCircle, currentStep === 'WRAP_UP' && styles.stepNumberCircleActive]}>
            <Text style={[styles.stepNumberText, currentStep === 'WRAP_UP' && styles.stepNumberTextActive]}>1</Text>
          </View>
          <Text style={[styles.stepTabText, currentStep === 'WRAP_UP' && styles.stepTabTextActive]}>
            Wrap-Up
          </Text>
        </TouchableOpacity>

        <View style={styles.stepConnector} />

        <TouchableOpacity
          style={[styles.stepTab, currentStep === 'SIGNATURE' && styles.stepTabActive]}
          onPress={() => {
            if (!afterPhoto) {
              Alert.alert('Photo Required', 'Please attach an after-service photo before proceeding to signature.');
              return;
            }
            if (!paymentMethod) {
              Alert.alert('Payment Required', 'Mandatory on-spot payment collection must be confirmed before proceeding to signature.');
              return;
            }
            setCurrentStep('SIGNATURE');
          }}
          activeOpacity={0.7}
        >
          <View style={[styles.stepNumberCircle, currentStep === 'SIGNATURE' && styles.stepNumberCircleActive]}>
            <Text style={[styles.stepNumberText, currentStep === 'SIGNATURE' && styles.stepNumberTextActive]}>2</Text>
          </View>
          <Text style={[styles.stepTabText, currentStep === 'SIGNATURE' && styles.stepTabTextActive]}>
            Signature
          </Text>
        </TouchableOpacity>

        <View style={styles.stepConnector} />

        <TouchableOpacity
          style={[styles.stepTab, currentStep === 'CONFIRMATION' && styles.stepTabActive]}
          onPress={() => {
            if (!paymentMethod) {
              Alert.alert('Payment Required', 'Mandatory on-spot payment collection must be confirmed.');
              return;
            }
            if (paths.length > 0) {
              setCurrentStep('CONFIRMATION');
            } else {
              Alert.alert('Signature Required', 'Please complete the customer signature step first.');
            }
          }}
          activeOpacity={0.7}
        >
          <View style={[styles.stepNumberCircle, currentStep === 'CONFIRMATION' && styles.stepNumberCircleActive]}>
            <Text style={[styles.stepNumberText, currentStep === 'CONFIRMATION' && styles.stepNumberTextActive]}>3</Text>
          </View>
          <Text style={[styles.stepTabText, currentStep === 'CONFIRMATION' && styles.stepTabTextActive]}>
            Confirm
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // =========================================================================
  // FULL-SCREEN COMPLETION SCREEN
  // =========================================================================
  if (isCompletedSuccess) {
    return (
      <View style={[styles.completionFullScreenContainer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.completionContentBox}>
          <View style={styles.completionIconWrapper}>
            <Text style={styles.completionCheckmark}>✅</Text>
          </View>
          <Text style={styles.completionHeading}>Work Order Completed!</Text>
          <Text style={styles.completionSubtitle}>
            Customer signature recorded, payment settled, and audit logs dispatched.
          </Text>
          <TouchableOpacity
            style={styles.returnToJobsBtn}
            onPress={() => {
              navigation.reset({
                index: 0,
                routes: [{ name: 'JobList' }],
              });
            }}
            activeOpacity={0.85}
          >
            <Ionicons name="briefcase-outline" size={20} color="#FFFFFF" style={{ marginRight: 8 }} />
            <Text style={styles.returnToJobsBtnText}>Return to Work Orders</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // =========================================================================
  // STAGE 2: WORK WRAP-UP & MATERIALS
  // =========================================================================
  if (currentStep === 'WRAP_UP') {
    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
      >
        {renderStepIndicator()}
        <ScrollView
          ref={scrollViewRef}
          style={styles.container}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.content, { paddingBottom: Math.max(220, keyboardHeight + 60) }]}
        >

        {/* Work Order Overview */}
        <View style={styles.card}>
          <Text style={styles.jobTitle}>{jobTitle}</Text>
          <View style={styles.customerRow}>
            <Ionicons name="person-circle-outline" size={18} color="#2563EB" />
            <Text style={styles.customerText}>Customer: {customerName}</Text>
          </View>
        </View>

        {/* After-Service Photo & Before Photo Card */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="images-outline" size={18} color="#2563EB" />
              <Text style={styles.sectionTitle}>Proof of Work Photos</Text>
            </View>
          </View>
          <Text style={styles.sectionSubtitle}>
            Attach an After-Service Photo documenting completed repairs and clean site handover.
          </Text>

          <View style={styles.photosGrid}>
            {/* Pre-Service Photo (Read-only or retake) */}
            <View style={styles.photoCard}>
              <View style={styles.photoCardHeader}>
                <Text style={styles.photoCardLabel}>Before Service</Text>
                {beforePhoto && <Ionicons name="checkmark-circle" size={14} color="#059669" />}
              </View>
              {beforePhoto ? (
                <View style={styles.photoThumbnailContainer}>
                  <Image source={{ uri: beforePhoto }} style={styles.photoThumbImg} resizeMode="cover" />
                  <View style={styles.photoThumbActions}>
                    <TouchableOpacity
                      style={styles.photoActionMiniBtn}
                      onPress={() => promptPhotoSource('before')}
                      disabled={photoUploading}
                    >
                      <Ionicons name="camera-reverse-outline" size={13} color="#2563EB" />
                      <Text style={styles.photoActionMiniText}>Retake</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.emptyPhotoBox}
                  onPress={() => promptPhotoSource('before')}
                  disabled={photoUploading}
                  activeOpacity={0.7}
                >
                  <Ionicons name="camera-outline" size={22} color="#6B7280" />
                  <Text style={styles.emptyPhotoBoxText}>+ Before Photo</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* After-Service Photo (Prominent Stage 2 Target) */}
            <View style={[styles.photoCard, !afterPhoto && styles.photoCardProminent]}>
              <View style={[styles.photoCardHeader, !afterPhoto && styles.photoCardHeaderProminent]}>
                <Text style={[styles.photoCardLabel, !afterPhoto && styles.photoCardLabelProminent]}>
                  After Service *
                </Text>
                {afterPhoto && <Ionicons name="checkmark-circle" size={14} color="#059669" />}
              </View>
              {afterPhoto ? (
                <View style={styles.photoThumbnailContainer}>
                  <Image source={{ uri: afterPhoto }} style={styles.photoThumbImg} resizeMode="cover" />
                  <View style={styles.photoThumbActions}>
                    <TouchableOpacity
                      style={styles.photoActionMiniBtn}
                      onPress={() => promptPhotoSource('after')}
                      disabled={photoUploading}
                    >
                      <Ionicons name="camera-reverse-outline" size={13} color="#2563EB" />
                      <Text style={styles.photoActionMiniText}>Retake</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.photoActionMiniBtn}
                      onPress={() => setAfterPhoto(null)}
                      disabled={photoUploading}
                    >
                      <Ionicons name="trash-outline" size={13} color="#EF4444" />
                      <Text style={[styles.photoActionMiniText, { color: '#EF4444' }]}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  style={[styles.emptyPhotoBox, styles.emptyPhotoBoxHighlight]}
                  onPress={() => promptPhotoSource('after')}
                  disabled={photoUploading}
                  activeOpacity={0.7}
                >
                  {photoUploading ? (
                    <ActivityIndicator size="small" color="#2563EB" />
                  ) : (
                    <>
                      <Ionicons name="camera" size={26} color="#2563EB" />
                      <Text style={styles.emptyPhotoHighlightText}>+ Capture After Photo</Text>
                      <Text style={styles.emptyPhotoSubText}>Post-service proof</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>

        {/* Step B: Parts & Materials Used Section */}
        {Boolean(afterPhoto) ? (
        <View style={styles.card}>
          {/* Top Row: Title */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name="construct-outline" size={18} color="#2563EB" />
            <Text style={styles.sectionTitle}>🛠️ Parts & Materials Used</Text>
          </View>
          {/* Subtitle */}
          <Text style={[styles.sectionSubtitle, { marginBottom: 0 }]}>
            Select replacement parts or items used from truck inventory.
          </Text>
          {/* Action Buttons Row */}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 10, marginBottom: 8 }}>
            <TouchableOpacity
              style={[
                styles.addPartBtn,
                {
                  flex: 1,
                  paddingVertical: 10,
                  paddingHorizontal: 8,
                  borderRadius: 8,
                  alignItems: 'center',
                  justifyContent: 'center',
                },
              ]}
              onPress={() => setShowPartPicker(!showPartPicker)}
              activeOpacity={0.7}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: '600',
                  color: '#2563EB',
                  textAlign: 'center',
                }}
              >
                {showPartPicker ? 'Close' : 'Truck Inventory'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.addPartBtn,
                {
                  flex: 1,
                  paddingVertical: 10,
                  paddingHorizontal: 8,
                  borderRadius: 8,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderColor: '#8B5CF6',
                  backgroundColor: '#F5F3FF',
                },
              ]}
              onPress={() => setShowCustomServiceInput(!showCustomServiceInput)}
              activeOpacity={0.7}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: '600',
                  color: '#7C3AED',
                  textAlign: 'center',
                }}
              >
                {showCustomServiceInput ? 'Close' : 'Custom Repair'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Standard Labor (No Extra Parts) Confirmation Button */}
          <TouchableOpacity
            style={[
              styles.standardLaborBtn,
              materialsChoiceMade && selectedMaterials.length === 0 && customServices.length === 0 && styles.standardLaborBtnActive,
            ]}
            onPress={handleConfirmStandardLabor}
            activeOpacity={0.7}
          >
            <Ionicons
              name={materialsChoiceMade && selectedMaterials.length === 0 && customServices.length === 0 ? "checkmark-circle" : "shield-checkmark-outline"}
              size={18}
              color={materialsChoiceMade && selectedMaterials.length === 0 && customServices.length === 0 ? "#059669" : "#2563EB"}
            />
            <Text
              style={[
                styles.standardLaborBtnText,
                materialsChoiceMade && selectedMaterials.length === 0 && customServices.length === 0 && styles.standardLaborBtnTextActive,
              ]}
            >
              {materialsChoiceMade && selectedMaterials.length === 0 && customServices.length === 0
                ? "✓ Standard Labor Confirmed (No Extra Parts)"
                : "Confirm Standard Labor (No Extra Parts)"}
            </Text>
          </TouchableOpacity>

          {/* Custom Repair / Service Input Form */}
          {showCustomServiceInput && (
            <View style={styles.customServiceInputBox}>
              <Text style={styles.customServiceInputHeading}>Add Custom Repair / Service ("Other")</Text>
              <Text style={styles.customServiceInputLabel}>Work Performed</Text>
              <TextInput
                style={styles.customTextInput}
                placeholder="e.g., Wire Soldering, Diagnostic, Component Repair"
                placeholderTextColor="#9CA3AF"
                value={customDescription}
                onChangeText={setCustomDescription}
              />
              <Text style={styles.customServiceInputLabel}>Charge Amount ($)</Text>
              <TextInput
                style={styles.customTextInput}
                placeholder="e.g., 25.00"
                placeholderTextColor="#9CA3AF"
                keyboardType="numeric"
                value={customAmount}
                onChangeText={setCustomAmount}
              />
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                <TouchableOpacity
                  style={styles.customCancelBtn}
                  onPress={() => {
                    setShowCustomServiceInput(false);
                    setCustomDescription('');
                    setCustomAmount('');
                  }}
                >
                  <Text style={styles.customCancelBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.customAddSubmitBtn}
                  onPress={handleAddCustomService}
                >
                  <Text style={styles.customAddSubmitBtnText}>+ Add Custom Service</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Part Picker Dropdown */}
          {showPartPicker && (
            <View style={styles.pickerBox}>
              <View style={styles.searchRow}>
                <Ionicons name="search-outline" size={16} color="#9CA3AF" />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search inventory by name, SKU..."
                  value={partSearchQuery}
                  onChangeText={setPartSearchQuery}
                  placeholderTextColor="#9CA3AF"
                />
                {partSearchQuery.length > 0 && (
                  <TouchableOpacity onPress={() => setPartSearchQuery('')}>
                    <Ionicons name="close-circle" size={16} color="#9CA3AF" />
                  </TouchableOpacity>
                )}
              </View>

              {loadingInventory ? (
                <ActivityIndicator size="small" color="#2563EB" style={{ marginVertical: 12 }} />
              ) : (
                <ScrollView style={styles.pickerList} nestedScrollEnabled={true}>
                  {filteredInventory.map((item) => {
                    const isSelected = selectedMaterials.some((m) => m.itemId === item.id);
                    const remainingStock = getItemRemainingStock(item);
                    const isOutOfStock = remainingStock <= 0;
                    return (
                      <TouchableOpacity
                        key={item.id}
                        style={[styles.pickerItem, isOutOfStock && { opacity: 0.55 }]}
                        onPress={() => {
                          if (isOutOfStock) {
                            Alert.alert('Out of Stock', 'No remaining stock available in truck inventory.');
                            return;
                          }
                          handleAddPart(item);
                        }}
                        activeOpacity={0.6}
                      >
                        <View style={{ flex: 1, marginRight: 8 }}>
                          <Text style={styles.pickerItemName}>{item.name}</Text>
                          <View style={styles.pickerItemMeta}>
                            <Text style={styles.pickerItemSku}>{item.sku}</Text>
                            <Text style={[styles.pickerItemStock, isOutOfStock && { color: '#EF4444', fontWeight: '700' }]}>
                              Stock: {remainingStock}
                            </Text>
                          </View>
                        </View>
                        <View style={styles.pickerItemRight}>
                          <Text style={styles.pickerItemPrice}>${item.unitCost.toFixed(2)}</Text>
                          <View style={[styles.selectBadge, isSelected && styles.selectBadgeActive]}>
                            <Ionicons
                              name={isSelected ? 'checkmark' : 'add'}
                              size={12}
                              color={isSelected ? '#059669' : '#2563EB'}
                            />
                            <Text
                              style={[
                                styles.selectBadgeText,
                                isSelected && { color: '#059669' },
                              ]}
                            >
                              {isSelected ? 'Added' : 'Select'}
                            </Text>
                          </View>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                  {filteredInventory.length === 0 && (
                    <Text style={styles.emptyPickerText}>No parts matching "{partSearchQuery}"</Text>
                  )}
                </ScrollView>
              )}
            </View>
          )}

          {/* Selected Materials List */}
          {selectedMaterials.length > 0 ? (
            <View style={styles.selectedMaterialsList}>
              {selectedMaterials.map((item) => (
                <View key={item.itemId} style={styles.materialRow}>
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={styles.materialName}>{item.name}</Text>
                    <Text style={styles.materialSku}>
                      {item.sku} • ${item.unitCost.toFixed(2)} / unit
                    </Text>
                  </View>

                  {/* Quantity Stepper */}
                  <View style={styles.stepperContainer}>
                    <TouchableOpacity
                      style={styles.stepperBtn}
                      onPress={() => handleUpdateQuantity(item.itemId, -1)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="remove" size={13} color="#374151" />
                    </TouchableOpacity>
                    <Text style={styles.stepperValue}>{item.quantity}</Text>
                    <TouchableOpacity
                      style={[
                        styles.stepperBtn,
                        (() => {
                          const invItem = availableInventory.find((i) => i.id === item.itemId);
                          const originalStock = invItem
                            ? typeof invItem.quantityInStock === 'number'
                              ? invItem.quantityInStock
                              : typeof invItem.stockQty === 'number'
                              ? invItem.stockQty
                              : 0
                            : 999;
                          return item.quantity >= originalStock ? { opacity: 0.4 } : null;
                        })(),
                      ]}
                      onPress={() => handleUpdateQuantity(item.itemId, 1)}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="add" size={13} color="#374151" />
                    </TouchableOpacity>
                  </View>

                  {/* Line Total & Remove */}
                  <View style={styles.lineTotalContainer}>
                    <Text style={styles.lineTotalText}>${item.totalCost.toFixed(2)}</Text>
                    <TouchableOpacity
                      onPress={() => handleRemovePart(item.itemId)}
                      style={styles.removePartBtn}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="trash-outline" size={15} color="#EF4444" />
                    </TouchableOpacity>
                  </View>
                </View>
              ))}

              {/* Parts Subtotal */}
              <View style={styles.materialsSummaryBar}>
                <View>
                  <Text style={styles.summaryLabel}>
                    Truck Parts ({selectedMaterials.length} items)
                  </Text>
                  <Text style={styles.summarySub}>Logged from truck inventory</Text>
                </View>
                <Text style={styles.summaryTotalValue}>${totalMaterialsCost.toFixed(2)}</Text>
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.emptyMaterialsBox}
              onPress={() => setShowPartPicker(true)}
              activeOpacity={0.7}
            >
              <Ionicons name="cube-outline" size={24} color="#9CA3AF" />
              <Text style={styles.emptyMaterialsText}>
                No truck parts recorded yet.
              </Text>
              <Text style={[styles.emptyMaterialsText, { fontSize: 11, color: '#2563EB', fontWeight: '700' }]}>
                Tap to select from truck inventory ➔
              </Text>
            </TouchableOpacity>
          )}

          {/* Custom Services ("Other") List */}
          {customServices.length > 0 && (
            <View style={styles.customServicesList}>
              <Text style={styles.customListHeader}>Custom Services / Other Work:</Text>
              {customServices.map((service) => (
                <View key={service.id} style={styles.materialRow}>
                  <View style={{ flex: 1, marginRight: 8 }}>
                    <Text style={styles.materialName}>{service.description}</Text>
                    <Text style={styles.materialSku}>Custom Repair / Other Service</Text>
                  </View>
                  <View style={styles.lineTotalContainer}>
                    <Text style={styles.lineTotalText}>${service.amount.toFixed(2)}</Text>
                    <TouchableOpacity
                      onPress={() => handleRemoveCustomService(service.id)}
                      style={styles.removePartBtn}
                      activeOpacity={0.7}
                    >
                      <Ionicons name="trash-outline" size={15} color="#EF4444" />
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
              <View style={[styles.materialsSummaryBar, { backgroundColor: '#F5F3FF', borderColor: '#DDD6FE' }]}>
                <View>
                  <Text style={[styles.summaryLabel, { color: '#6D28D9' }]}>
                    Custom Services ({customServices.length} items)
                  </Text>
                  <Text style={styles.summarySub}>Custom labor & diagnostic fees</Text>
                </View>
                <Text style={[styles.summaryTotalValue, { color: '#7C3AED' }]}>${totalCustomServicesCost.toFixed(2)}</Text>
              </View>
            </View>
          )}

          {/* Dynamic Running Bill Card */}
          <View style={styles.runningBillCard}>
            <View style={styles.runningBillRow}>
              <Text style={styles.runningBillLabel}>Base Labor Fee:</Text>
              <Text style={styles.runningBillValue}>${baseLaborFee.toFixed(2)}</Text>
            </View>
            <View style={styles.runningBillRow}>
              <Text style={styles.runningBillLabel}>Truck Parts Used ({selectedMaterials.length}):</Text>
              <Text style={styles.runningBillValue}>${totalMaterialsCost.toFixed(2)}</Text>
            </View>
            <View style={styles.runningBillRow}>
              <Text style={styles.runningBillLabel}>Custom Repair / Other ({customServices.length}):</Text>
              <Text style={styles.runningBillValue}>${totalCustomServicesCost.toFixed(2)}</Text>
            </View>
            <View style={styles.runningBillDivider} />
            <View style={[styles.runningBillRow, { marginTop: 4 }]}>
              <Text style={styles.runningBillTotalLabel}>Total Running Bill:</Text>
              <Text style={styles.runningBillTotalValue}>${totalBill.toFixed(2)}</Text>
            </View>
          </View>
        </View>
        ) : (
          <View style={[styles.card, styles.lockedCard]}>
            <View style={styles.lockedCardHeader}>
              <Ionicons name="lock-closed-outline" size={18} color="#94A3B8" />
              <Text style={styles.lockedCardTitle}>Parts & Materials (Step B - Locked)</Text>
            </View>
            <Text style={styles.lockedCardText}>
              Capture After-Service Photo above to record materials or confirm standard labor.
            </Text>
          </View>
        )}

        {/* Step C: Mandatory On-Spot Payment Collection Card */}
        {Boolean(afterPhoto) && hasMaterialsChoice ? (
        <View style={styles.card}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, marginRight: 8 }}>
              <Ionicons name="cash-outline" size={20} color="#059669" />
              <Text style={[styles.sectionTitle, { flex: 1 }]} numberOfLines={1}>
                💵 On-Spot Payment
              </Text>
            </View>
            <View style={[styles.paymentStatusPill, paymentMethod ? styles.paymentStatusPillConfirmed : styles.paymentStatusPillPending]}>
              <Text style={[styles.paymentStatusPillText, paymentMethod ? styles.paymentStatusPillTextConfirmed : styles.paymentStatusPillTextPending]}>
                {paymentMethod ? '✓ PAYMENT RECORDED' : 'REQUIRED ON-SPOT'}
              </Text>
            </View>
          </View>
          <Text style={styles.sectionSubtitle}>
            Technician must record customer payment of ${totalBill.toFixed(2)} before handing device to customer.
          </Text>

          {/* Payment Method Selector */}
          <View style={styles.paymentMethodToggleRow}>
            <TouchableOpacity
              style={[
                styles.paymentMethodOption,
                paymentMethod === 'CASH_ON_SITE' && styles.paymentMethodOptionActive,
              ]}
              onPress={() => setPaymentMethod('CASH_ON_SITE')}
              activeOpacity={0.8}
            >
              <View style={styles.paymentMethodRadio}>
                {paymentMethod === 'CASH_ON_SITE' && <View style={styles.paymentMethodRadioInner} />}
              </View>
              <Text style={styles.paymentMethodIcon}>💵</Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.paymentMethodTitle, paymentMethod === 'CASH_ON_SITE' && styles.paymentMethodTitleActive]}>
                  Cash Collected on Site
                </Text>
                <Text style={styles.paymentMethodDesc}>Received in full directly from customer</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.paymentMethodOption,
                paymentMethod === 'ONLINE_TRANSFER' && styles.paymentMethodOptionActive,
              ]}
              onPress={() => setPaymentMethod('ONLINE_TRANSFER')}
              activeOpacity={0.8}
            >
              <View style={styles.paymentMethodRadio}>
                {paymentMethod === 'ONLINE_TRANSFER' && <View style={styles.paymentMethodRadioInner} />}
              </View>
              <Text style={styles.paymentMethodIcon}>📲</Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.paymentMethodTitle, paymentMethod === 'ONLINE_TRANSFER' && styles.paymentMethodTitleActive]}>
                  Direct Bank / Digital Transfer
                </Text>
                <Text style={styles.paymentMethodDesc}>Instant transfer verified on technician mobile</Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* Digital Reference Input */}
          {paymentMethod === 'ONLINE_TRANSFER' && (
            <View style={styles.digitalRefBox}>
              <Text style={styles.digitalRefLabel}>Transaction ID / Reference Number (Optional)</Text>
              <TextInput
                style={styles.digitalRefInput}
                placeholder="e.g. TXN-84920491 or Bank Ref Code"
                placeholderTextColor="#9CA3AF"
                value={paymentRefNumber}
                onChangeText={setPaymentRefNumber}
                onFocus={() => {
                  setTimeout(() => {
                    scrollViewRef.current?.scrollToEnd({ animated: true });
                  }, 120);
                }}
              />
            </View>
          )}

          {!paymentMethod && (
            <View style={styles.paymentAlertWarning}>
              <Ionicons name="warning-outline" size={15} color="#D97706" />
              <Text style={styles.paymentAlertWarningText}>
                You must record on-spot payment before the customer signature step is unlocked.
              </Text>
            </View>
          )}
        </View>
        ) : Boolean(afterPhoto) ? (
          <View style={[styles.card, styles.lockedCard]}>
            <View style={styles.lockedCardHeader}>
              <Ionicons name="lock-closed-outline" size={18} color="#94A3B8" />
              <Text style={styles.lockedCardTitle}>On-Spot Payment (Step C - Locked)</Text>
            </View>
            <Text style={styles.lockedCardText}>
              Select parts or confirm standard labor above to unlock on-spot payment collection.
            </Text>
          </View>
        ) : null}

        {/* Step D: Primary Transition Button: Proceed to Customer Signature */}
        <TouchableOpacity
          style={[
            styles.primaryStageBtn,
            (!afterPhoto || !hasMaterialsChoice || !paymentMethod) && styles.primaryStageBtnDisabled,
            afterPhoto && hasMaterialsChoice && paymentMethod && styles.primaryStageBtnHighlighted,
          ]}
          onPress={() => {
            if (!afterPhoto) {
              Alert.alert('Photo Required', 'Please attach an after-service photo before proceeding.');
              return;
            }
            if (!hasMaterialsChoice) {
              Alert.alert('Materials Confirmation Required', 'Please record parts used or confirm standard labor before proceeding.');
              return;
            }
            if (!paymentMethod) {
              Alert.alert(
                'Payment Collection Required',
                'Mandatory on-spot payment collection must be confirmed before handing device to customer.'
              );
              return;
            }
            setCurrentStep('SIGNATURE');
          }}
          disabled={!afterPhoto || !hasMaterialsChoice || !paymentMethod}
          activeOpacity={0.85}
        >
          <Ionicons
            name="person"
            size={20}
            color={!afterPhoto || !hasMaterialsChoice || !paymentMethod ? '#94A3B8' : '#FFFFFF'}
          />
          <Text
            style={[
              styles.primaryStageBtnText,
              (!afterPhoto || !hasMaterialsChoice || !paymentMethod) && styles.primaryStageBtnTextDisabled,
              afterPhoto && hasMaterialsChoice && paymentMethod && styles.primaryStageBtnTextHighlighted,
            ]}
          >
            Proceed to Customer Signature
          </Text>
          <Ionicons
            name="arrow-forward"
            size={18}
            color={!afterPhoto || !hasMaterialsChoice || !paymentMethod ? '#94A3B8' : '#FFFFFF'}
          />
        </TouchableOpacity>
        {(!afterPhoto || !hasMaterialsChoice || !paymentMethod) && (
          <Text style={styles.afterPhotoHelperText}>
            {!afterPhoto
              ? 'Take after-service photo to proceed to parts & materials.'
              : !hasMaterialsChoice
              ? 'Select parts or confirm standard labor to proceed to payment.'
              : 'Record on-spot payment collection to unlock customer signature.'}
          </Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
  }

  // =========================================================================
  // STAGE 3: DEDICATED LARGE, ULTRA-SMOOTH SIGNATURE PAD
  // =========================================================================
  if (currentStep === 'SIGNATURE') {
    return (
      <View
        style={[
          styles.signatureScreenContainer,
          {
            paddingBottom: Math.max(insets.bottom, Platform.OS === 'android' ? 24 : 16),
          },
        ]}
      >
        {/* Header bar */}
        <View style={styles.signatureTopBar}>
          <TouchableOpacity
            style={styles.backToWrapUpBtn}
            onPress={() => setCurrentStep('WRAP_UP')}
            activeOpacity={0.7}
          >
            <Ionicons name="chevron-back" size={18} color="#2563EB" />
            <Text style={styles.backToWrapUpText}>Back to Wrap-Up</Text>
          </TouchableOpacity>
          <View style={styles.signerPill}>
            <Ionicons name="person-circle" size={16} color="#059669" />
            <Text style={styles.signerPillText}>{customerName}</Text>
          </View>
        </View>

        {/* Customer instruction banner */}
        <View style={styles.signaturePromptBanner}>
          <Text style={styles.signaturePromptTitle}>Customer Signature Sign-Off</Text>
          <Text style={styles.signaturePromptSub}>
            Please sign with your finger inside the box below to authorize completion.
          </Text>
        </View>

        {/* Dedicated Signature Canvas: >= 60% of screen height */}
        <View style={styles.canvasContainer}>
          <View
            {...panResponder.panHandlers}
            collapsable={false}
            pointerEvents="auto"
            style={[
              styles.signaturePadWrapper,
              signatureError ? styles.signaturePadWrapperError : null,
            ]}
          >
            {/* Guide line & text */}
            <View style={styles.signatureBaseline} pointerEvents="none" />
            <Text style={styles.signatureBaselineText} pointerEvents="none">
              Sign Above This Line
            </Text>

            {/* SVG Canvas rendering with Quadratic Bézier curves */}
            <Svg
              width={SIGNATURE_PAD_WIDTH}
              height={SIGNATURE_PAD_HEIGHT}
              viewBox={`0 0 ${SIGNATURE_PAD_WIDTH} ${SIGNATURE_PAD_HEIGHT}`}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            >
              {paths.length === 0 && !currentPath && (
                <SvgText
                  x={SIGNATURE_PAD_WIDTH / 2}
                  y={SIGNATURE_PAD_HEIGHT / 2 - 15}
                  textAnchor="middle"
                  fill="#94A3B8"
                  fontSize="15"
                  fontWeight="600"
                >
                  Touch and draw customer signature here
                </SvgText>
              )}
              {paths.map((p, idx) => (
                <Path
                  key={`path-${idx}`}
                  d={p}
                  stroke="#0F172A"
                  strokeWidth={3.5}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {currentPath ? (
                <Path
                  d={currentPath}
                  stroke="#0F172A"
                  strokeWidth={3.5}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : null}
            </Svg>
          </View>

          {signatureError && (
            <View style={styles.signatureErrorRow}>
              <Ionicons name="alert-circle" size={16} color="#DC2626" />
              <Text style={styles.signatureErrorText}>{signatureError}</Text>
            </View>
          )}
        </View>

        {/* Bottom Actions: Clear & Accept Signature */}
        <View
          style={[
            styles.signatureBottomBar,
            {
              marginBottom: Math.max(insets.bottom, 16),
            },
          ]}
        >
          <TouchableOpacity
            style={[
              styles.sigClearBtn,
              paths.length === 0 && !currentPath && styles.sigClearBtnDisabled,
            ]}
            onPress={handleClearSignature}
            disabled={paths.length === 0 && !currentPath}
            activeOpacity={0.7}
          >
            <Ionicons
              name="refresh-outline"
              size={18}
              color={paths.length === 0 && !currentPath ? '#9CA3AF' : '#DC2626'}
            />
            <Text
              style={[
                styles.sigClearBtnText,
                paths.length === 0 && !currentPath && styles.sigClearBtnTextDisabled,
              ]}
            >
              Clear
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.sigAcceptBtn}
            onPress={handleAcceptSignature}
            activeOpacity={0.85}
          >
            <Ionicons name="checkmark-circle" size={20} color="#FFFFFF" />
            <Text style={styles.sigAcceptBtnText}>Accept Signature</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // =========================================================================
  // STAGE 4: FINAL NOTES & CONFIRMATION
  // =========================================================================
  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 20}
    >
      {renderStepIndicator()}
      <ScrollView
        ref={confirmationScrollRef}
        style={styles.container}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: 180 }]}
      >
        {/* 1. Job Title & Customer Signer Header Card */}
        <View style={styles.card}>
          <Text style={styles.jobTitle}>{jobTitle}</Text>
          <View style={styles.customerRow}>
            <Ionicons name="person-circle-outline" size={18} color="#2563EB" />
            <Text style={styles.customerText}>Customer Signer: {customerName}</Text>
          </View>
          <View style={styles.gpsBadge}>
            <Ionicons name="location-outline" size={14} color="#059669" />
            <Text style={styles.gpsBadgeText}>GPS location will be verified upon sign-off</Text>
          </View>
        </View>

        {/* 2. "Proof Photos Preview" Card */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="images-outline" size={18} color="#2563EB" />
              <Text style={styles.sectionTitle}>Proof Photos Preview</Text>
            </View>
            <TouchableOpacity
              style={styles.reSignBtn}
              onPress={() => setCurrentStep('WRAP_UP')}
              activeOpacity={0.7}
            >
              <Ionicons name="create-outline" size={14} color="#2563EB" />
              <Text style={styles.reSignBtnText}>Edit Photos</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.proofPhotosRow}>
            {beforePhoto && (
              <View style={styles.proofPhotoCol}>
                <Text style={styles.proofPhotoLabel}>Before Service</Text>
                <Image source={{ uri: beforePhoto }} style={styles.proofPhotoPreviewImg} resizeMode="cover" />
              </View>
            )}
            {afterPhoto && (
              <View style={styles.proofPhotoCol}>
                <Text style={styles.proofPhotoLabel}>After Service</Text>
                <Image source={{ uri: afterPhoto }} style={styles.proofPhotoPreviewImg} resizeMode="cover" />
              </View>
            )}
            {!beforePhoto && !afterPhoto && (
              <Text style={styles.emptyPreviewText}>No photos attached</Text>
            )}
          </View>
        </View>

        {/* Read-Only Summary of Materials & On-Spot Settlement */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>On-Spot Financial Settlement</Text>
          <View style={{ marginTop: 8, gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 13, color: '#334155' }}>Base Labor & Diagnostics</Text>
              <Text style={{ fontSize: 13, fontWeight: '700', color: '#334155' }}>
                ${baseLaborFee.toFixed(2)}
              </Text>
            </View>

            {selectedMaterials.length > 0 && (
              <View style={{ marginTop: 4, paddingLeft: 6, borderLeftWidth: 2, borderLeftColor: '#E2E8F0', gap: 4 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#64748B', textTransform: 'uppercase' }}>
                  Truck Parts ({selectedMaterials.length} items):
                </Text>
                {selectedMaterials.map((m) => (
                  <View key={m.itemId} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: '#475569' }}>
                      {m.name} (x{m.quantity})
                    </Text>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: '#334155' }}>
                      ${m.totalCost.toFixed(2)}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {customServices.length > 0 && (
              <View style={{ marginTop: 4, paddingLeft: 6, borderLeftWidth: 2, borderLeftColor: '#DDD6FE', gap: 4 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#7C3AED', textTransform: 'uppercase' }}>
                  Custom Repairs ({customServices.length} items):
                </Text>
                {customServices.map((s) => (
                  <View key={s.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 12, color: '#475569' }}>
                      {s.description}
                    </Text>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: '#7C3AED' }}>
                      ${s.amount.toFixed(2)}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.confirmMaterialsTotal}>
              <Text style={styles.confirmMaterialsTotalLabel}>Total Settlement Paid:</Text>
              <Text style={styles.confirmMaterialsTotalVal}>${totalBill.toFixed(2)}</Text>
            </View>

            <View style={{ marginTop: 4, padding: 8, backgroundColor: '#ECFDF5', borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: '#A7F3D0' }}>
              <Ionicons name="checkmark-circle" size={16} color="#059669" />
              <Text style={{ fontSize: 12, fontWeight: '700', color: '#065F46' }}>
                Status: PAID via {paymentMethod === 'ONLINE_TRANSFER' ? 'Direct Bank / Digital Transfer' : 'Cash Collected on Site'}{paymentRefNumber ? ` (${paymentRefNumber})` : ''}
              </Text>
            </View>
          </View>
        </View>

        {/* 3. "Customer Signature" Card */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="shield-checkmark" size={18} color="#059669" />
              <Text style={styles.sectionTitle}>Customer Signature</Text>
            </View>
            <TouchableOpacity
              style={styles.reSignBtn}
              onPress={() => setCurrentStep('SIGNATURE')}
              activeOpacity={0.7}
            >
              <Ionicons name="create-outline" size={14} color="#2563EB" />
              <Text style={styles.reSignBtnText}>Re-Sign</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.signaturePreviewBox}>
            <Svg
              width={SIGNATURE_PAD_WIDTH - 32}
              height={130}
              viewBox={`0 0 ${SIGNATURE_PAD_WIDTH} ${SIGNATURE_PAD_HEIGHT}`}
            >
              {paths.map((p, idx) => (
                <Path
                  key={`preview-path-${idx}`}
                  d={p}
                  stroke="#0F172A"
                  strokeWidth={3.5}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </Svg>
            <View style={styles.signatureAcceptedBanner}>
              <Ionicons name="checkmark-circle" size={14} color="#059669" />
              <Text style={styles.signatureAcceptedText}>Signature Accepted • {customerName}</Text>
            </View>
          </View>
        </View>

        {/* 4. "Technician Completion Notes *" Card */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Technician Completion Notes *</Text>
          <Text style={styles.sectionSubtitle}>
            Document diagnostics, service performed, parts replaced, and results.
          </Text>

          {/* Subtle Prompt Badge */}
          <View style={styles.notesPromptBadge}>
            <Text style={styles.notesPromptBadgeText}>
              📝 Please describe the work performed (min. 5 chars)
            </Text>
          </View>

          <TextInput
            ref={notesInputRef}
            style={[
              styles.textInput,
              isNotesFocused ? styles.textInputFocused : styles.textInputDefault,
              submitAttempted && completionNotes.trim().length < 5 && styles.textInputWarning,
            ]}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            placeholder="e.g. Diagnosed refrigerant leak at expansion valve, replaced valve and filter drier, recharged 4.2 lbs R410A..."
            placeholderTextColor="#9CA3AF"
            value={completionNotes}
            onChangeText={setCompletionNotes}
            onFocus={() => {
              setIsNotesFocused(true);
              setTimeout(() => {
                confirmationScrollRef.current?.scrollToEnd({ animated: true });
              }, 120);
            }}
            onBlur={() => setIsNotesFocused(false)}
          />
          {completionNotes.trim().length < 5 ? (
            <View style={styles.notesWarningContainer}>
              <Ionicons name="information-circle-outline" size={15} color="#64748B" />
              <Text style={styles.notesHelperText}>
                Minimum 5 characters required before job can be completed ({completionNotes.trim().length}/5).
              </Text>
            </View>
          ) : (
            <View style={styles.notesWarningContainer}>
              <Ionicons name="checkmark-circle-outline" size={15} color="#059669" />
              <Text style={styles.notesSuccessText}>
                Completion notes provided.
              </Text>
            </View>
          )}
        </View>

        {/* 5. "Confirm & Complete Job" Button */}
        <TouchableOpacity
          style={[
            styles.submitBtn,
            (completionNotes.trim().length < 5 || submitting) && styles.submitBtnDisabled,
          ]}
          onPress={handleCompleteJob}
          disabled={completionNotes.trim().length < 5 || submitting}
          activeOpacity={0.8}
        >
          {submitting ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color="#FFFFFF" size="small" style={{ marginRight: 8 }} />
              <Text style={styles.submitBtnText}>Submitting & Syncing...</Text>
            </View>
          ) : (
            <>
              <Ionicons
                name="checkmark-done-circle"
                size={22}
                color={completionNotes.trim().length < 5 ? '#94A3B8' : '#FFFFFF'}
              />
              <Text
                style={[
                  styles.submitBtnText,
                  (completionNotes.trim().length < 5 || submitting) && styles.submitBtnDisabledText,
                ]}
              >
                Confirm & Complete Job
              </Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>

      {/* Work Order Closed Confirmation Modal */}
      <Modal
        visible={completionModalVisible}
        transparent
        animationType="fade"
        onRequestClose={handleReturnToJobs}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalSuccessIconBox}>
              <Ionicons name="checkmark-circle" size={38} color="#059669" />
            </View>

            <Text style={styles.modalTitle}>
              {completionModalData?.title || 'Work Order Closed'}
            </Text>

            <Text style={styles.modalMessage}>
              {completionModalData?.message ||
                'The job has been completed and customer sign-off synced to dispatch.'}
            </Text>

            {!!completionModalData?.locationNotice && (
              <View style={styles.modalGpsBadge}>
                <Ionicons name="location" size={13} color="#059669" />
                <Text style={styles.modalGpsText}>
                  {completionModalData.locationNotice}
                </Text>
              </View>
            )}

            <View style={styles.modalActionsContainer}>
              <TouchableOpacity
                style={styles.modalPrimaryBtn}
                onPress={handleReturnToJobs}
                activeOpacity={0.85}
              >
                <Text style={styles.modalPrimaryBtnText}>Return to Work Orders</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  completionFullScreenContainer: {
    flex: 1,
    backgroundColor: '#0F172A',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  completionContentBox: {
    backgroundColor: '#1E293B',
    borderRadius: 20,
    padding: 32,
    alignItems: 'center',
    width: '100%',
    maxWidth: 400,
    borderWidth: 1,
    borderColor: '#334155',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 8,
  },
  completionIconWrapper: {
    marginBottom: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  completionCheckmark: {
    fontSize: 64,
  },
  completionHeading: {
    fontSize: 22,
    fontWeight: '800',
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 10,
  },
  completionSubtitle: {
    fontSize: 14,
    color: '#94A3B8',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 30,
  },
  returnToJobsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#059669',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 12,
    width: '100%',
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  returnToJobsBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  content: {
    padding: 16,
    gap: 14,
    paddingBottom: 40,
  },
  // Step Indicator
  stickyStepperBar: {
    backgroundColor: '#ffffff',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    zIndex: 10,
  },
  progressStepperContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  stepTabActive: {
    backgroundColor: '#EFF6FF',
  },
  stepNumberCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumberCircleActive: {
    backgroundColor: '#2563EB',
  },
  stepNumberText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#6B7280',
  },
  stepNumberTextActive: {
    color: '#FFFFFF',
  },
  stepTabText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6B7280',
  },
  stepTabTextActive: {
    color: '#2563EB',
    fontWeight: '800',
  },
  stepConnector: {
    height: 1,
    flex: 1,
    backgroundColor: '#E5E7EB',
    marginHorizontal: 4,
  },
  // Card Containers
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  jobTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#111827',
    marginBottom: 6,
  },
  customerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  customerText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4B5563',
  },
  gpsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
    backgroundColor: '#ECFDF5',
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  gpsBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#065F46',
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
  },
  sectionSubtitle: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 2,
    marginBottom: 10,
    lineHeight: 18,
  },
  // Photos in Stage 2
  photoCountBadge: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  photoCountBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#2563EB',
  },
  photosGrid: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  photoCard: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    overflow: 'hidden',
  },
  photoCardProminent: {
    borderColor: '#93C5FD',
    backgroundColor: '#F8FAFF',
  },
  photoCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#F1F5F9',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  photoCardHeaderProminent: {
    backgroundColor: '#EFF6FF',
    borderBottomColor: '#DBEAFE',
  },
  photoCardLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
  },
  photoCardLabelProminent: {
    color: '#1D4ED8',
  },
  photoThumbnailContainer: {
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
  },
  photoThumbImg: {
    width: '100%',
    height: 120,
    backgroundColor: '#E5E7EB',
  },
  photoThumbActions: {
    flexDirection: 'row',
    padding: 6,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    backgroundColor: '#FFFFFF',
    justifyContent: 'space-around',
  },
  photoActionMiniBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 6,
  },
  photoActionMiniText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#2563EB',
  },
  emptyPhotoBox: {
    height: 130,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 10,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#CBD5E1',
    borderRadius: 8,
    margin: 8,
    backgroundColor: '#FFFFFF',
  },
  emptyPhotoBoxHighlight: {
    borderColor: '#3B82F6',
    backgroundColor: '#EFF6FF',
  },
  emptyPhotoBoxText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
    textAlign: 'center',
  },
  emptyPhotoHighlightText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#2563EB',
    textAlign: 'center',
  },
  emptyPhotoSubText: {
    fontSize: 11,
    color: '#3B82F6',
  },
  // Parts & Materials
  addPartBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  addPartBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#2563EB',
  },
  pickerBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 10,
    marginBottom: 12,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
    gap: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: '#1E293B',
    padding: 0,
  },
  pickerList: {
    maxHeight: 180,
  },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#F1F5F9',
    marginBottom: 6,
  },
  pickerItemName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1E293B',
  },
  pickerItemMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  pickerItemSku: {
    fontSize: 11,
    color: '#64748B',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  pickerItemStock: {
    fontSize: 11,
    fontWeight: '600',
    color: '#059669',
  },
  pickerItemRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  pickerItemPrice: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0F172A',
  },
  selectBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  selectBadgeActive: {
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
  },
  selectBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#2563EB',
  },
  emptyPickerText: {
    textAlign: 'center',
    fontSize: 12,
    color: '#94A3B8',
    paddingVertical: 12,
  },
  selectedMaterialsList: {
    gap: 8,
  },
  materialRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 10,
  },
  materialName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1E293B',
  },
  materialSku: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 2,
  },
  stepperContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    marginRight: 10,
  },
  stepperBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperValue: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0F172A',
    minWidth: 20,
    textAlign: 'center',
  },
  lineTotalContainer: {
    alignItems: 'flex-end',
    minWidth: 60,
  },
  lineTotalText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#059669',
  },
  removePartBtn: {
    padding: 3,
    marginTop: 2,
  },
  materialsSummaryBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#ECFDF5',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#A7F3D0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 4,
  },
  summaryLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#065F46',
  },
  summarySub: {
    fontSize: 10,
    color: '#047857',
    marginTop: 1,
  },
  summaryTotalValue: {
    fontSize: 16,
    fontWeight: '800',
    color: '#065F46',
  },
  emptyMaterialsBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#CBD5E1',
    borderRadius: 8,
    backgroundColor: '#F8FAFC',
    gap: 6,
  },
  emptyMaterialsText: {
    fontSize: 12,
    color: '#64748B',
  },
  emptyAddBtn: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    marginTop: 2,
  },
  emptyAddBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#2563EB',
  },
  primaryStageBtn: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 8,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
  primaryStageBtnHighlighted: {
    backgroundColor: '#16A34A',
    borderColor: '#15803D',
    borderWidth: 1.5,
    shadowColor: '#16A34A',
    shadowOpacity: 0.35,
    elevation: 4,
  },
  primaryStageBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  primaryStageBtnTextHighlighted: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  primaryStageBtnDisabled: {
    backgroundColor: '#E2E8F0',
    elevation: 0,
    shadowOpacity: 0,
  },
  primaryStageBtnTextDisabled: {
    color: '#94A3B8',
  },
  standardLaborBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#F0FDF4',
    borderWidth: 1.5,
    borderColor: '#BBF7D0',
    borderRadius: 8,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginTop: 8,
  },
  standardLaborBtnActive: {
    backgroundColor: '#DCFCE7',
    borderColor: '#22C55E',
  },
  standardLaborBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#15803D',
  },
  standardLaborBtnTextActive: {
    color: '#166534',
    fontWeight: '800',
  },
  lockedCard: {
    backgroundColor: '#F8FAFC',
    borderColor: '#E2E8F0',
    borderStyle: 'dashed',
    opacity: 0.85,
  },
  lockedCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  lockedCardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#64748B',
  },
  lockedCardText: {
    fontSize: 12,
    color: '#94A3B8',
    lineHeight: 18,
  },
  afterPhotoHelperText: {
    textAlign: 'center',
    fontSize: 12,
    color: '#D97706',
    fontWeight: '600',
    marginTop: 8,
  },

  // STAGE 3: Dedicated Full Signature Screen
  signatureScreenContainer: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 16,
    paddingTop: 10,
    justifyContent: 'space-between',
  },
  signatureTopBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  backToWrapUpBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  backToWrapUpText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#2563EB',
  },
  signerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#ECFDF5',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#A7F3D0',
  },
  signerPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#065F46',
  },
  signaturePromptBanner: {
    marginBottom: 4,
  },
  signaturePromptTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
  },
  signaturePromptSub: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 1,
  },
  canvasContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    maxHeight: 460,
  },
  // High-contrast canvas border (borderWidth: 2, borderColor: '#0F172A')
  signaturePadWrapper: {
    width: SIGNATURE_PAD_WIDTH,
    height: SIGNATURE_PAD_HEIGHT,
    maxHeight: 450,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#0F172A',
    position: 'relative',
    overflow: 'hidden',
  },
  signaturePadWrapperError: {
    borderColor: '#DC2626',
    backgroundColor: '#FEF2F2',
  },
  signatureBaseline: {
    position: 'absolute',
    bottom: 45,
    left: 20,
    right: 20,
    borderBottomWidth: 1.5,
    borderBottomColor: '#94A3B8',
    borderStyle: 'dashed',
  },
  signatureBaselineText: {
    position: 'absolute',
    bottom: 22,
    left: 20,
    fontSize: 12,
    color: '#64748B',
    fontWeight: '700',
  },
  signatureErrorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  signatureErrorText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#DC2626',
  },
  signatureBottomBar: {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 0,
    marginTop: 8,
  },
  sigClearBtn: {
    flex: 1,
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 10,
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  sigClearBtnDisabled: {
    backgroundColor: '#F1F5F9',
    borderColor: '#E2E8F0',
  },
  sigClearBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#DC2626',
  },
  sigClearBtnTextDisabled: {
    color: '#94A3B8',
  },
  sigAcceptBtn: {
    flex: 2,
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 10,
    backgroundColor: '#059669',
    shadowColor: '#059669',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
    elevation: 3,
  },
  sigAcceptBtnText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#FFFFFF',
  },

  // STAGE 4: Confirmation Screen
  textInput: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    color: '#111827',
    minHeight: 90,
  },
  textInputDefault: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  textInputFocused: {
    borderWidth: 2,
    borderColor: '#2563eb',
    backgroundColor: '#f8fafc',
  },
  notesPromptBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 8,
  },
  notesPromptBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1D4ED8',
  },
  textInputWarning: {
    borderColor: '#F59E0B',
    borderWidth: 1.5,
    backgroundColor: '#FFFBEB',
  },
  notesWarningContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 2,
  },
  notesWarningText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#D97706',
    flex: 1,
  },
  notesHelperText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
    flex: 1,
  },
  notesSuccessText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#059669',
    flex: 1,
  },
  reSignBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  reSignBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#2563EB',
  },
  signaturePreviewBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 8,
    alignItems: 'center',
    marginTop: 4,
  },
  signatureAcceptedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  signatureAcceptedText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#059669',
  },
  proofPhotosRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  proofPhotoCol: {
    flex: 1,
    gap: 4,
  },
  proofPhotoLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
  },
  proofPhotoPreviewImg: {
    width: '100%',
    height: 100,
    borderRadius: 8,
    backgroundColor: '#E5E7EB',
  },
  emptyPreviewText: {
    fontSize: 12,
    color: '#94A3B8',
    fontStyle: 'italic',
    paddingVertical: 8,
  },
  confirmMaterialsTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    paddingTop: 6,
    marginTop: 4,
  },
  confirmMaterialsTotalLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
  },
  confirmMaterialsTotalVal: {
    fontSize: 14,
    fontWeight: '800',
    color: '#059669',
  },
  submitBtn: {
    backgroundColor: '#2563EB',
    paddingVertical: 16,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
    elevation: 3,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
  submitBtnDisabled: {
    backgroundColor: '#E2E8F0',
    elevation: 0,
    shadowOpacity: 0,
  },
  submitBtnDisabledText: {
    color: '#94A3B8',
  },
  submitBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  // Completion Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 10,
  },
  modalSuccessIconBox: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#ECFDF5',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0F172A',
    textAlign: 'center',
    marginBottom: 8,
  },
  modalMessage: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  modalGpsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F0FDF4',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#DCFCE7',
    marginBottom: 18,
  },
  modalGpsText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#15803D',
  },
  modalActionsContainer: {
    width: '100%',
  },
  modalPrimaryBtn: {
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 8,
  },
  modalPrimaryBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  modalSecondaryBtn: {
    backgroundColor: '#f1f5f9',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalSecondaryBtnText: {
    color: '#334155',
    fontSize: 14,
    fontWeight: '600',
  },
  runningBillCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 12,
    marginTop: 14,
  },
  runningBillRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3,
  },
  runningBillLabel: {
    fontSize: 13,
    color: '#64748B',
  },
  runningBillValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1E293B',
  },
  runningBillDivider: {
    height: 1,
    backgroundColor: '#CBD5E1',
    marginVertical: 6,
  },
  runningBillTotalLabel: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0F172A',
  },
  runningBillTotalValue: {
    fontSize: 16,
    fontWeight: '800',
    color: '#059669',
  },
  customServiceInputBox: {
    backgroundColor: '#F5F3FF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#DDD6FE',
    padding: 12,
    marginTop: 10,
  },
  customServiceInputHeading: {
    fontSize: 13,
    fontWeight: '700',
    color: '#6D28D9',
    marginBottom: 8,
  },
  customServiceInputLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#5B21B6',
    textTransform: 'uppercase',
    marginTop: 4,
    marginBottom: 3,
  },
  customTextInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#C4B5FD',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    color: '#1E293B',
  },
  customCancelBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
  },
  customCancelBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
  },
  customAddSubmitBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#7C3AED',
  },
  customAddSubmitBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  customServicesList: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingTop: 8,
  },
  customListHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6D28D9',
    marginBottom: 6,
  },
  paymentStatusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    flexShrink: 0,
  },
  paymentStatusPillConfirmed: {
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
  },
  paymentStatusPillPending: {
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  paymentStatusPillText: {
    fontSize: 11,
    fontWeight: '700',
  },
  paymentStatusPillTextConfirmed: {
    color: '#065F46',
  },
  paymentStatusPillTextPending: {
    color: '#92400E',
  },
  paymentMethodToggleRow: {
    gap: 10,
    marginTop: 12,
  },
  paymentMethodOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
    gap: 10,
  },
  paymentMethodOptionActive: {
    borderColor: '#059669',
    backgroundColor: '#F0FDF4',
  },
  paymentMethodRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#CBD5E1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  paymentMethodRadioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#059669',
  },
  paymentMethodIcon: {
    fontSize: 22,
  },
  paymentMethodTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1E293B',
  },
  paymentMethodTitleActive: {
    color: '#065F46',
  },
  paymentMethodDesc: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 1,
  },
  digitalRefBox: {
    marginTop: 10,
    backgroundColor: '#F8FAFC',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  digitalRefLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 4,
  },
  digitalRefInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    color: '#0F172A',
  },
  paymentAlertWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    padding: 8,
    borderRadius: 6,
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  paymentAlertWarningText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#B45309',
    flex: 1,
  },
});
