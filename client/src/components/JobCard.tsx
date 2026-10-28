import React from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Job } from '../types';
import { PriorityBadge, StatusBadge } from './Badge';

interface JobCardProps {
  job: Job;
  onPress: () => void;
}

export const JobCard = React.memo<JobCardProps>(({ job, onPress }) => {
  const hasConflict = job.conflict === true;
  const isPendingSync =
    !hasConflict &&
    (job.pending_sync === true ||
      job.is_synced === false ||
      (job.pending_sync === undefined &&
        job.is_synced === undefined &&
        Boolean(job.clientUpdatedAt) &&
        !job.syncedAt));

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      style={[styles.card, hasConflict && styles.cardConflict]}
      onPress={onPress}
    >
      <View style={styles.cardHeader}>
        <View style={styles.headerLeft}>
          <Text style={styles.customerName}>{job.customerName}</Text>
          {hasConflict && (
            <View style={styles.conflictPill}>
              <Ionicons name="warning" size={11} color="#DC2626" />
              <Text style={styles.conflictText}>Conflict (409)</Text>
            </View>
          )}
          {isPendingSync && (
            <View style={styles.pendingSyncPill}>
              <Ionicons name="cloud-upload" size={11} color="#D97706" />
              <Text style={styles.pendingSyncText}>Pending Sync</Text>
            </View>
          )}
        </View>
        <PriorityBadge priority={job.priority} />
      </View>

      <Text style={styles.jobTitle}>{job.title}</Text>
      <Text style={styles.jobDesc} numberOfLines={2}>
        {job.description}
      </Text>

      {/* Completion Proofs & Artifacts Preview */}
      {job.status === 'COMPLETED' && (
        <View style={styles.proofsRow}>
          {Boolean(job.beforePhotoUrl || (job as any).beforePhoto) && (
            <View style={styles.proofThumbWrapper}>
              <Image
                source={{ uri: (job.beforePhotoUrl || (job as any).beforePhoto)! }}
                style={styles.proofThumb}
                resizeMode="cover"
              />
              <Text style={styles.proofThumbLabel}>Before</Text>
            </View>
          )}
          {Boolean(job.afterPhotoUrl || (job as any).afterPhoto) && (
            <View style={styles.proofThumbWrapper}>
              <Image
                source={{ uri: (job.afterPhotoUrl || (job as any).afterPhoto)! }}
                style={styles.proofThumb}
                resizeMode="cover"
              />
              <Text style={styles.proofThumbLabel}>After</Text>
            </View>
          )}
          {Boolean(job.signatureData || job.signatureSvg) && (
            <View style={styles.proofChip}>
              <Ionicons name="shield-checkmark" size={12} color="#059669" />
              <Text style={styles.proofChipText}>Signed</Text>
            </View>
          )}
          {Boolean(job.materialsUsed) && (
            <View style={[styles.proofChip, { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' }]}>
              <Ionicons name="construct" size={12} color="#2563EB" />
              <Text style={[styles.proofChipText, { color: '#1E40AF' }]}>Materials</Text>
            </View>
          )}
        </View>
      )}

      <View style={styles.cardFooter}>
        <View style={styles.metaRow}>
          <Ionicons name="location-outline" size={15} color="#6B7280" />
          <Text style={styles.metaText} numberOfLines={1}>
            {job.customerAddress}
          </Text>
        </View>
        <StatusBadge status={job.status} />
      </View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    elevation: 2,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    borderWidth: 1,
    borderColor: '#F3F4F6',
  },
  cardConflict: {
    borderColor: '#FECACA',
    backgroundColor: '#FFFBFB',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  customerName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#4B5563',
  },
  conflictPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#FEE2E2',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  conflictText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#B91C1C',
  },
  pendingSyncPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  pendingSyncText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#B45309',
  },
  jobTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 6,
  },
  jobDesc: {
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 20,
    marginBottom: 12,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingTop: 12,
    gap: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 4,
  },
  metaText: {
    fontSize: 13,
    color: '#6B7280',
    flexShrink: 1,
  },
  proofsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
    paddingTop: 4,
    flexWrap: 'wrap',
  },
  proofThumbWrapper: {
    alignItems: 'center',
    gap: 2,
  },
  proofThumb: {
    width: 36,
    height: 36,
    borderRadius: 6,
    backgroundColor: '#E2E8F0',
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  proofThumbLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: '#64748B',
  },
  proofChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#ECFDF5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  proofChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#065F46',
  },
});

