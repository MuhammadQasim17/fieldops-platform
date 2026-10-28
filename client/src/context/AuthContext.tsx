import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { User } from '../types';
import {
  getAuthToken,
  getAuthUser,
  saveAuthSession,
  clearAuthSession,
} from '../services/storage';
import {
  loginUser,
  registerAccountRevokedHandler,
  fetchWithBaseUrlFallback,
  subscribeToRealtimeEvents,
} from '../services/api';

export interface AuthContextType {
  user: User | null;
  setUser: (user: User | null) => void;
  token: string | null;
  setToken: (token: string | null) => void;
  isAuthenticated: boolean;
  setIsAuthenticated: (val: boolean) => void;
  isLoading: boolean;
  loading: boolean;
  setLoading: (val: boolean) => void;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  handleForceSignOut: () => Promise<void>;
  loadStoredSession: () => Promise<void>;
  loadStoredAuth: () => Promise<void>;
  checkAuth: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  const signOut = async () => {
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
        'has_prompted_gps',
      ]);
      await AsyncStorage.removeItem('has_prompted_gps');
      await clearAuthSession();
    } finally {
      setUser(null);
      setToken(null);
      setIsAuthenticated(false);
    }
  };

  const handleForceSignOut = signOut;

  const loadStoredSession = useCallback(async () => {
    try {
      setLoading(true);
      const storedToken = (await AsyncStorage.getItem('auth_token')) || (await getAuthToken());

      // If AsyncStorage.getItem('auth_token') is null or empty, DO NOT attempt to sign in with demo credentials or set a fallback user. Simply set setLoading(false) and leave user as null.
      if (!storedToken || storedToken.trim() === '') {
        setUser(null);
        setToken(null);
        setIsAuthenticated(false);
        setLoading(false);
        return;
      }

      const storedProfileRaw = (await AsyncStorage.getItem('user_profile')) || (await AsyncStorage.getItem('user'));
      let storedUser: User | null = null;
      if (storedProfileRaw) {
        try {
          storedUser = JSON.parse(storedProfileRaw);
        } catch {}
      }
      if (!storedUser) {
        storedUser = await getAuthUser();
      }

      if (!storedUser || !storedUser.id) {
        setUser(null);
        setToken(null);
        setIsAuthenticated(false);
        setLoading(false);
        return;
      }

      // Immediately restore stored session for zero-latency startup
      setUser(storedUser);
      setToken(storedToken);
      setIsAuthenticated(true);
      setLoading(false);

      // Verify remote account state in the background asynchronously without blocking UI mount
      fetchWithBaseUrlFallback(
        `/jobs?assignedTechId=${encodeURIComponent(storedUser.id)}&t=${Date.now()}`,
        {
          headers: { Authorization: `Bearer ${storedToken}` },
        },
        3500
      )
        .then(async (verifyRes) => {
          if (verifyRes.status === 401 || verifyRes.status === 403) {
            const errData = await verifyRes.json().catch(() => ({}));
            if (
              verifyRes.status === 403 ||
              errData?.error === 'NOT_A_MEMBER' ||
              errData?.error === 'ACCOUNT_DELETED' ||
              errData?.error === 'ACCOUNT_NOT_FOUND' ||
              errData?.message?.includes('removed') ||
              errData?.message?.includes('deactivated')
            ) {
              console.warn('[AuthContext] Account was removed or deactivated on server. Purging local session.');
              await AsyncStorage.multiRemove(['user', 'token', 'cached_jobs', 'has_prompted_gps']);
              await AsyncStorage.removeItem('has_prompted_gps');
              await signOut();
            }
          }
        })
        .catch(() => {
          // Offline or unreachable: retain valid pre-authenticated session for offline field operations
        });
    } catch (err) {
      console.warn('[AuthContext] Failed to load stored auth:', err);
      setUser(null);
      setToken(null);
      setIsAuthenticated(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStoredAuth = loadStoredSession;

  const checkAuth = useCallback(async (): Promise<boolean> => {
    await loadStoredSession();
    const currentToken = (await AsyncStorage.getItem('auth_token')) || (await getAuthToken());
    const currentUser = (await AsyncStorage.getItem('user_profile')) || (await getAuthUser());
    return Boolean(currentToken && currentUser);
  }, [loadStoredSession]);

  const signIn = useCallback(async (email: string, password: string) => {
    const authData = await loginUser(email, password);
    if (!authData?.user || !authData?.token) {
      throw new Error('Invalid login response from server');
    }
    await saveAuthSession(authData.token, authData.user);
    setUser(authData.user);
    setToken(authData.token);
    setIsAuthenticated(true);
  }, []);

  useEffect(() => {
    registerAccountRevokedHandler(() => {
      signOut();
    });
    loadStoredSession();
  }, [loadStoredSession]);

  useEffect(() => {
    if (!user?.id) return;
    const unsub = subscribeToRealtimeEvents(async (eventType, data) => {
      if (eventType === 'STAFF_REMOVED') {
        const removedTechId = data?.technicianId || data?.id;
        if (removedTechId === user.id) {
          console.warn('[AuthContext] STAFF_REMOVED event received for active session.');
          await AsyncStorage.multiRemove(['user', 'token', 'cached_jobs', 'has_prompted_gps']);
          await AsyncStorage.removeItem('has_prompted_gps');
          await signOut();
        }
      }
    });
    return () => {
      unsub();
    };
  }, [user?.id, signOut]);

  return (
    <AuthContext.Provider
      value={{
        user,
        setUser,
        token,
        setToken,
        isAuthenticated,
        setIsAuthenticated,
        isLoading: loading,
        loading,
        setLoading,
        signIn,
        signOut,
        handleForceSignOut,
        loadStoredSession,
        loadStoredAuth,
        checkAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
