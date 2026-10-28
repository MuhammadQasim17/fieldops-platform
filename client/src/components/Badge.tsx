import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { JobPriority, JobStatus } from '../types';

interface PriorityBadgeProps {
  priority: JobPriority | string;
}

interface StatusBadgeProps {
  status: JobStatus | string;
  size?: 'small' | 'medium' | 'large';
}

export function getPriorityBadgeColor(priority: string): string {
  switch (priority) {
    case 'EMERGENCY':
      return '#EF4444';
    case 'HIGH':
      return '#F97316';
    case 'MEDIUM':
      return '#EAB308';
    default:
      return '#10B981';
  }
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'IN_PROGRESS':
      return '#3B82F6';
    case 'EN_ROUTE':
      return '#8B5CF6';
    case 'COMPLETED':
      return '#10B981';
    default:
      return '#6B7280';
  }
}

export const PriorityBadge: React.FC<PriorityBadgeProps> = ({ priority }) => {
  const backgroundColor = getPriorityBadgeColor(priority);

  return (
    <View style={[styles.priorityBadge, { backgroundColor }]}>
      <Text style={styles.priorityBadgeText}>{priority}</Text>
    </View>
  );
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, size = 'small' }) => {
  const color = getStatusColor(status);
  const isLarge = size === 'large';

  return (
    <View
      style={[
        styles.statusBadge,
        { backgroundColor: `${color}18` },
        isLarge && styles.statusBadgeLarge,
      ]}
    >
      <View style={[styles.statusDot, { backgroundColor: color }]} />
      <Text
        style={[
          styles.statusBadgeText,
          { color },
          isLarge && styles.statusBadgeTextLarge,
        ]}
      >
        {status.replace('_', ' ')}
      </Text>
    </View>
  );
};

export function getRoleColor(role?: string | null): { bg: string; text: string; border: string; label: string } {
  switch (role) {
    case 'FIELD_ENGINEER':
      return { bg: '#EEF2FF', text: '#4F46E5', border: '#C7D2FE', label: 'Field Engineer' };
    case 'INSPECTOR':
      return { bg: '#ECFDF5', text: '#059669', border: '#A7F3D0', label: 'Site Inspector' };
    case 'SUPERVISOR':
      return { bg: '#FAF5FF', text: '#7E22CE', border: '#E9D5FF', label: 'Supervisor' };
    case 'DISPATCHER':
      return { bg: '#FFF1F2', text: '#E11D48', border: '#FECDD3', label: 'Dispatcher' };
    case 'TECHNICIAN':
    default:
      return { bg: '#F0F9FF', text: '#0284C7', border: '#BAE6FD', label: 'Field Tech' };
  }
}

export const RoleBadge: React.FC<{ role?: string | null; size?: 'small' | 'medium' }> = ({
  role,
  size = 'small',
}) => {
  const info = getRoleColor(role);
  const isSmall = size === 'small';

  return (
    <View
      style={[
        styles.roleBadge,
        { backgroundColor: info.bg, borderColor: info.border },
        !isSmall && styles.roleBadgeMedium,
      ]}
    >
      <Text
        style={[
          styles.roleBadgeText,
          { color: info.text },
          !isSmall && styles.roleBadgeTextMedium,
        ]}
      >
        {info.label}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  priorityBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    height: 22,
    borderRadius: 12,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    alignItems: 'center',
  },
  priorityBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 2,
    height: 22,
    borderRadius: 12,
    gap: 4,
  },
  statusBadgeLarge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    height: 24,
    borderRadius: 12,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  statusBadgeTextLarge: {
    fontSize: 12,
  },
  roleBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  roleBadgeMedium: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  roleBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  roleBadgeTextMedium: {
    fontSize: 12,
  },
});


