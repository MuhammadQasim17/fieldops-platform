import React, { useEffect } from 'react';
import { ActivityIndicator, LogBox, StatusBar, View } from 'react-native';

// Suppress non-fatal dev warning toasts for background GPS location pings
LogBox.ignoreLogs([
  'Initial GPS location ping failed',
  'Periodic GPS location ping failed',
  'Foreground location permission not granted for live tracking',
  '[GPS]',
]);
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RootStackParamList } from './src/types';
import { LoginScreen } from './src/screens/LoginScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { JobListScreen } from './src/screens/JobListScreen';
import { JobDetailScreen } from './src/screens/JobDetailScreen';
import { SignatureScreen } from './src/screens/SignatureScreen';
import { initNetworkAutoSync, registerAccountRevokedHandler } from './src/services/api';
import { clearCorruptedCacheOnAppStart } from './src/services/storage';
import { AuthProvider, useAuth } from './src/context/AuthContext';

const Stack = createNativeStackNavigator<RootStackParamList>();
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

function AppNavigator() {
  const { isAuthenticated, isLoading, handleForceSignOut } = useAuth();

  useEffect(() => {
    // Run one-time clear of existing corrupted legacy cache items on initial app upgrade
    const purgeCorruptedCache = async () => {
      try {
        const alreadyPurged = await AsyncStorage.getItem('@fieldops_purged_corrupted_v2');
        if (!alreadyPurged) {
          await AsyncStorage.removeItem('jobs_cache');
          await AsyncStorage.removeItem('offline_sync_queue');
          await clearCorruptedCacheOnAppStart();
          await AsyncStorage.setItem('@fieldops_purged_corrupted_v2', 'true');
        }
      } catch (err) {
        console.warn('Failed to clear corrupted cache on app start:', err);
      }
    };
    purgeCorruptedCache();

    registerAccountRevokedHandler(async () => {
      console.warn('[App] Account revoked event received. Resetting navigation stack to LoginScreen.');
      await handleForceSignOut();
      if (navigationRef.isReady()) {
        navigationRef.reset({
          index: 0,
          routes: [{ name: 'LoginScreen' }],
        });
      }
    });

    const unsub = initNetworkAutoSync();
    return () => {
      unsub();
    };
  }, [handleForceSignOut]);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />
      <NavigationContainer ref={navigationRef}>
        <Stack.Navigator
          initialRouteName={isAuthenticated ? 'HomeScreen' : 'LoginScreen'}
          screenOptions={{
            headerStyle: {
              backgroundColor: '#FFFFFF',
            },
            headerTintColor: '#111827',
            headerTitleStyle: {
              fontWeight: '700',
              fontSize: 17,
            },
            headerShadowVisible: false,
            contentStyle: {
              backgroundColor: '#F9FAFB',
            },
          }}
        >
          <Stack.Screen
            name="LoginScreen"
            component={LoginScreen}
            options={{
              headerShown: false,
            }}
          />
          <Stack.Screen
            name="Login"
            component={LoginScreen}
            options={{
              headerShown: false,
            }}
          />
          <Stack.Screen
            name="HomeScreen"
            component={HomeScreen}
            options={{
              headerShown: false,
            }}
          />
          <Stack.Screen
            name="Home"
            component={HomeScreen}
            options={{
              headerShown: false,
            }}
          />
          <Stack.Screen
            name="JobList"
            component={JobListScreen}
            options={{
              headerShown: false,
            }}
          />
          <Stack.Screen
            name="JobDetail"
            component={JobDetailScreen}
            options={{
              title: 'Work Order Details',
              headerBackTitle: 'Orders',
            }}
          />
          <Stack.Screen
            name="Signature"
            component={SignatureScreen}
            options={{
              title: 'Customer Sign-Off',
              headerBackTitle: 'Back',
            }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppNavigator />
    </AuthProvider>
  );
}
