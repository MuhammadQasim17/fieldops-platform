import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNetInfo } from '@react-native-community/netinfo';
import { Ionicons } from '@expo/vector-icons';

interface ConnectivityBannerProps {
  showOnlineDot?: boolean;
  style?: any;
}

export const ConnectivityBanner: React.FC<ConnectivityBannerProps> = ({
  showOnlineDot = true,
  style,
}) => {
  const netInfo = useNetInfo();
  const isOffline =
    netInfo.isConnected === false ||
    (netInfo.isConnected === true && netInfo.isInternetReachable === false);

  if (isOffline) {
    return (
      <View style={[styles.offlineBanner, style]}>
        <Ionicons name="cloud-offline" size={16} color="#B45309" />
        <Text style={styles.offlineText}>
          Offline Mode - Actions will sync automatically when reconnected
        </Text>
      </View>
    );
  }

  if (showOnlineDot && netInfo.isConnected) {
    return (
      <View style={[styles.onlineContainer, style]}>
        <View style={styles.greenDot} />
        <Text style={styles.onlineText}>Online</Text>
      </View>
    );
  }

  return null;
};

const styles = StyleSheet.create({
  offlineBanner: {
    backgroundColor: '#FEF3C7',
    borderColor: '#FCD34D',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 8,
  },
  offlineText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#92400E',
    flex: 1,
    lineHeight: 16,
  },
  onlineContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 4,
    gap: 6,
  },
  greenDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#10B981',
  },
  onlineText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#059669',
  },
});

