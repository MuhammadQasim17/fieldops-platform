import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { useAuth } from '../context/AuthContext';
import {
  loginUser,
  getApiBaseUrl,
  setApiBaseUrl,
  getApiUrlOverride,
  setApiUrlOverride,
  detectExpoHostLanUrl,
} from '../services/api';

type LoginNavProp = NativeStackNavigationProp<RootStackParamList, 'Login'>;

export const LoginScreen: React.FC = () => {
  const navigation = useNavigation<LoginNavProp>();
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState(getApiBaseUrl());
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [customUrlInput, setCustomUrlInput] = useState(getApiBaseUrl());

  // Ensure no automated execution on mount:
  // The login function MUST ONLY be called when the user manually taps the "Sign In" button.
  // There is strictly no automated useEffect(() => { handleLogin(); }, []) or focus-triggered auto-login.

  React.useEffect(() => {
    getApiUrlOverride().then((override) => {
      if (override) {
        setServerUrl(override);
        setCustomUrlInput(override);
      } else {
        const detected = getApiBaseUrl();
        setServerUrl(detected);
        setCustomUrlInput(detected);
      }
    });
  }, []);

  const handleSaveServerUrl = async () => {
    const trimmed = customUrlInput.trim();
    if (!trimmed) return;
    await setApiBaseUrl(trimmed);
    const updated = getApiBaseUrl();
    setServerUrl(updated);
    setShowServerConfig(false);
    Alert.alert('Server URL Updated', `API endpoint set to:\n${updated}`);
  };

  const handleResetServerUrl = async () => {
    await setApiUrlOverride(null);
    const def = detectExpoHostLanUrl();
    await setApiBaseUrl(def);
    setServerUrl(def);
    setCustomUrlInput(def);
    setShowServerConfig(false);
    Alert.alert('Reset to Auto-Detect', `API endpoint restored to:\n${def}`);
  };

  const handleLogin = async () => {
    const cleanEmail = email.trim();
    const cleanPassword = password.trim();
    if (!cleanEmail || !cleanPassword) {
      setErrorMessage('Please enter both your work email and password.');
      return;
    }

    setErrorMessage(null);
    setLoading(true);

    try {
      await signIn(cleanEmail, cleanPassword);
      navigation.reset({
        index: 0,
        routes: [{ name: 'JobList' }],
      });
    } catch (error: any) {
      console.warn('[Auth] Login error:', error);
      const displayMessage =
        error?.message ||
        'You are not a member of this company. Contact your supervisor to be added to the team directory.';
      Alert.alert('Access Denied', displayMessage);
      setErrorMessage(displayMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Brand Header */}
          <View style={styles.header}>
            <View style={styles.logoBadge}>
              <Ionicons name="construct" size={32} color="#FFFFFF" />
            </View>
            <Text style={styles.brandTitle}>FieldOps Platform</Text>
            <Text style={styles.brandSubtitle}>
              Technician & Field Engineer Sign In
            </Text>
          </View>

          {/* Login Card */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Technician Sign In</Text>
            <Text style={styles.cardDesc}>
              Enter your provisioned technician credentials received via email
            </Text>

            {/* Error Banner */}
            {errorMessage && (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle" size={18} color="#DC2626" />
                <Text style={styles.errorText}>{errorMessage}</Text>
              </View>
            )}

            {/* Email Field */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Work Email</Text>
              <View style={styles.inputContainer}>
                <Ionicons name="mail-outline" size={18} color="#6B7280" style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter your approved work email"
                  placeholderTextColor="#94A3B8"
                  value={email}
                  onChangeText={(val) => {
                    setEmail(val);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                />
              </View>
            </View>

            {/* Password Field */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.inputContainer}>
                <Ionicons name="lock-closed-outline" size={18} color="#6B7280" style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter your assigned password"
                  placeholderTextColor="#94A3B8"
                  value={password}
                  onChangeText={(val) => {
                    setPassword(val);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity
                  style={styles.eyeBtn}
                  onPress={() => setShowPassword(!showPassword)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={20}
                    color="#6B7280"
                  />
                </TouchableOpacity>
              </View>
            </View>

            {/* Sign In Button */}
            <TouchableOpacity
              style={[styles.loginBtn, loading && styles.loginBtnDisabled]}
              onPress={handleLogin}
              disabled={loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <View style={styles.btnRow}>
                  <Text style={styles.loginBtnText}>Sign In</Text>
                  <Ionicons name="arrow-forward" size={18} color="#FFFFFF" />
                </View>
              )}
            </TouchableOpacity>

            {/* Dispatcher Support Contact Info */}
            <View style={{ alignItems: 'center', marginTop: 16 }}>
              <Text style={{ fontSize: 12, color: '#64748B', textAlign: 'center' }}>
                Need credentials or dispatch assistance? Contact:
              </Text>
              <Text style={{ fontSize: 12, color: '#2563EB', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', marginTop: 4, fontWeight: '600' }}>
                fieldops.dispatch@gmail.com
              </Text>
            </View>

            {/* Server Connection Endpoint & LAN Routing Override */}
            <View style={styles.serverSection}>
              <TouchableOpacity
                style={styles.serverPill}
                onPress={() => setShowServerConfig(!showServerConfig)}
                activeOpacity={0.7}
              >
                <Ionicons name="wifi" size={13} color="#2563EB" />
                <Text style={styles.serverPillText} numberOfLines={1}>
                  Server: {serverUrl}
                </Text>
                <Ionicons
                  name={showServerConfig ? 'chevron-up' : 'settings-outline'}
                  size={13}
                  color="#6B7280"
                />
              </TouchableOpacity>

              {showServerConfig && (
                <View style={styles.serverConfigBox}>
                  <Text style={styles.serverConfigTitle}>Backend API Host Configuration</Text>
                  <Text style={styles.serverConfigDesc}>
                    Auto-detected LAN host tracks your computer's Wi-Fi IP. You can override it manually below:
                  </Text>
                  <TextInput
                    style={styles.serverConfigInput}
                    value={customUrlInput}
                    onChangeText={setCustomUrlInput}
                    placeholder="https://fieldops-platform-server.vercel.app/api"
                    placeholderTextColor="#9CA3AF"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <View style={styles.serverConfigActions}>
                    <TouchableOpacity
                      style={styles.serverResetBtn}
                      onPress={handleResetServerUrl}
                    >
                      <Text style={styles.serverResetBtnText}>Auto-Detect</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.serverSaveBtn}
                      onPress={handleSaveServerUrl}
                    >
                      <Text style={styles.serverSaveBtnText}>Save Host</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>
          </View>

          {/* Footer Note */}
          <View style={styles.footer}>
            <Ionicons name="shield-checkmark-outline" size={14} color="#6B7280" />
            <Text style={styles.footerText}>
              Admin-provisioned access protected by FieldOps JWT authentication
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 36,
    paddingBottom: 24,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 28,
  },
  logoBadge: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
  brandTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: -0.5,
  },
  brandSubtitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#94A3B8',
    marginTop: 4,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 24,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.15,
    shadowRadius: 24,
    elevation: 6,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0F172A',
  },
  cardDesc: {
    fontSize: 13,
    color: '#64748B',
    marginTop: 4,
    marginBottom: 18,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FEF2F2',
    borderColor: '#FCA5A5',
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    marginBottom: 16,
  },
  errorText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: '#991B1B',
  },
  inputGroup: {
    marginBottom: 16,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  inputIcon: {
    marginRight: 8,
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: '#0F172A',
    paddingVertical: 12,
  },
  eyeBtn: {
    padding: 6,
  },
  loginBtn: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  loginBtnDisabled: {
    opacity: 0.65,
  },
  btnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  loginBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 24,
    paddingHorizontal: 16,
  },
  footerText: {
    fontSize: 11,
    color: '#64748B',
    textAlign: 'center',
  },
  serverSection: {
    marginTop: 12,
  },
  serverPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 6,
  },
  serverPillText: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#334155',
    flex: 1,
  },
  serverConfigBox: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
  },
  serverConfigTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 4,
  },
  serverConfigDesc: {
    fontSize: 11,
    color: '#64748B',
    lineHeight: 15,
    marginBottom: 8,
  },
  serverConfigInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#94A3B8',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#0F172A',
    marginBottom: 8,
  },
  serverConfigActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  serverResetBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
  },
  serverResetBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#475569',
  },
  serverSaveBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#2563EB',
  },
  serverSaveBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});

