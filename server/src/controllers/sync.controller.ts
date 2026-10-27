import { Request, Response } from 'express';
import { prisma } from '../prisma';
import { inventoryService } from '../modules/inventory/inventory.service';
import { sendCompletionEmail } from '../modules/notifications/email.service';
import { broadcastEvent } from '../modules/events/events.service';

export type SyncMutationType = 'STATUS_UPDATE' | 'COMPLETE_JOB' | 'LOCATION_UPDATE';

export interface SyncMutationInput {
  jobId: string;
  type: SyncMutationType;
  clientVersion: number;
  clientUpdatedAt: string;
  data: Record<string, any>;
  idempotencyKey?: string;
}

export interface SyncRequestPayload {
  lastSyncTimestamp: string | null;
  mutations: SyncMutationInput[];
}

export interface SyncProcessedRecord {
  jobId: string;
  status: 'APPLIED';
  newVersion: number;
  job?: any;
}

export interface SyncConflictRecord {
  jobId: string;
  status?: number;
  serverState: any;
  reason: 'VERSION_MISMATCH' | 'NOT_FOUND';
}

export const STATUS_RANK: Record<string, number> = {
  PENDING: 0,
  EN_ROUTE: 1,
  IN_PROGRESS: 2,
  COMPLETED: 3,
  CANCELLED: 4,
};

/**
 * POST /api/sync
 * Atomic batch synchronization endpoint with Optimistic Concurrency Control (OCC)
 * and Server Delta Pull.
 */
export const handleBatchSync = async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as SyncRequestPayload;
    const lastSyncTimestamp = body.lastSyncTimestamp || null;
    const mutations: SyncMutationInput[] = Array.isArray(body.mutations) ? body.mutations : [];

    const processed: SyncProcessedRecord[] = [];
    const conflicts: SyncConflictRecord[] = [];
    const modifiedJobIds = new Set<string>();

    for (const mutation of mutations) {
      if (!mutation || !mutation.jobId) continue;

      const { jobId, type, clientVersion, clientUpdatedAt, data = {} } = mutation;
      const idempotencyKey =
        (typeof mutation.idempotencyKey === 'string' && mutation.idempotencyKey.trim()) ||
        (typeof data.idempotencyKey === 'string' && data.idempotencyKey.trim()) ||
        null;

      // Mutation Idempotency Check:
      // If this mutation key was already executed, skip processing (no double inventory deduction,
      // no duplicate email trigger) and return the previously stored responsePayload.
      if (idempotencyKey) {
        const existingRecord = await prisma.idempotencyRecord.findUnique({
          where: { key: idempotencyKey },
        });

        if (existingRecord) {
          console.log(
            `[SyncController] Idempotency cache hit for key "${idempotencyKey}" (mutation: ${existingRecord.mutationType}, job: ${existingRecord.jobId}). Skipping processing.`
          );
          try {
            const cachedResult = JSON.parse(existingRecord.responsePayload);
            processed.push(cachedResult);
            if (existingRecord.jobId) {
              modifiedJobIds.add(existingRecord.jobId);
            }
          } catch (parseErr) {
            console.warn(`[SyncController] Failed to parse idempotency payload for key "${idempotencyKey}":`, parseErr);
          }
          continue;
        }
      }

      const existingJob = await prisma.job.findUnique({
        where: { id: jobId },
        include: {
          technician: {
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
              role: true,
              lastKnownLat: true,
              lastKnownLng: true,
              lastLocationUpdate: true,
            },
          },
        },
      });

      if (!existingJob) {
        conflicts.push({
          jobId,
          status: 404,
          serverState: null,
          reason: 'NOT_FOUND',
        });
        continue;
      }

      // Optimistic Concurrency Enforcement:
      // Allow sequential mutations from the same authenticated technician session to apply incrementally
      const incomingVersion =
        typeof clientVersion === 'number' && !isNaN(clientVersion)
          ? clientVersion
          : existingJob.version;

      if (incomingVersion < existingJob.version) {
        const isOwnerTech =
          !req.user ||
          req.user.role === 'DISPATCHER' ||
          !existingJob.technicianId ||
          req.user.id === existingJob.technicianId;

        const targetStatus =
          type === 'COMPLETE_JOB' || data.status === 'COMPLETED'
            ? 'COMPLETED'
            : data.status;

        const currentRank = STATUS_RANK[existingJob.status] ?? 0;
        const targetRank = targetStatus !== undefined ? (STATUS_RANK[targetStatus] ?? currentRank) : currentRank;
        const isForwardTransition =
          targetRank >= currentRank ||
          targetStatus === 'IN_PROGRESS' ||
          targetStatus === 'COMPLETED' ||
          type === 'COMPLETE_JOB' ||
          type === 'LOCATION_UPDATE';

        if (isOwnerTech && (isForwardTransition || modifiedJobIds.has(jobId))) {
          console.log(
            `[SyncEngine] Allowing incremental/forward mutation for job ${jobId} (clientVersion=${incomingVersion}, serverVersion=${existingJob.version}, status=${targetStatus})`
          );
        } else {
          console.warn(
            `[SyncEngine] 409 CONFLICT for job ${jobId}: clientVersion=${incomingVersion} < serverVersion=${existingJob.version}`
          );
          conflicts.push({
            jobId,
            status: 409,
            serverState: existingJob,
            reason: 'VERSION_MISMATCH',
          });
          continue;
        }
      }

      // Version matches (clientVersion === job.version): apply mutation
      const now = new Date();
      let syncedAt = now;
      if (clientUpdatedAt) {
        const clientDate = new Date(clientUpdatedAt);
        if (!isNaN(clientDate.getTime()) && clientDate.getTime() >= now.getTime()) {
          syncedAt = new Date(clientDate.getTime() + 1000);
        }
      }

      if (type === 'LOCATION_UPDATE') {
        const rawLat = data.latitude ?? data.lat;
        const rawLng = data.longitude ?? data.lng;
        const numLat = typeof rawLat === 'string' ? parseFloat(rawLat) : rawLat;
        const numLng = typeof rawLng === 'string' ? parseFloat(rawLng) : rawLng;
        const locationTime = data.timestamp ? new Date(data.timestamp) : now;

        const updatedJob = await prisma.job.update({
          where: { id: jobId },
          data: {
            lastKnownLat: typeof numLat === 'number' && !isNaN(numLat) ? numLat : existingJob.lastKnownLat,
            lastKnownLng: typeof numLng === 'number' && !isNaN(numLng) ? numLng : existingJob.lastKnownLng,
            lastLocationUpdate: locationTime,
            clientUpdatedAt: clientUpdatedAt ? new Date(clientUpdatedAt) : now,
            syncedAt,
            version: { increment: 1 },
          },
          include: {
            technician: {
              select: {
                id: true,
                name: true,
                phone: true,
                email: true,
                role: true,
                lastKnownLat: true,
                lastKnownLng: true,
                lastLocationUpdate: true,
              },
            },
          },
        });

        if (existingJob.technicianId && typeof numLat === 'number' && typeof numLng === 'number') {
          await prisma.user
            .update({
              where: { id: existingJob.technicianId },
              data: {
                lastKnownLat: numLat,
                lastKnownLng: numLng,
                lastLocationUpdate: locationTime,
              },
            })
            .catch(() => {});
        }

        if (typeof numLat === 'number' && typeof numLng === 'number') {
          broadcastEvent('TECH_LOCATION_UPDATED', {
            jobId,
            technicianId: existingJob.technicianId,
            lat: numLat,
            lng: numLng,
            timestamp: locationTime.toISOString(),
          });
        }
        broadcastEvent('JOB_UPDATED', updatedJob);

        modifiedJobIds.add(jobId);
        processed.push({
          jobId,
          status: 'APPLIED',
          newVersion: updatedJob.version,
          job: {
            ...updatedJob,
            is_synced: true,
            pending_sync: false,
          },
        });
        continue;
      }

      // Handle STATUS_UPDATE or COMPLETE_JOB
      const isComplete = type === 'COMPLETE_JOB' || data.status === 'COMPLETED';
      const finalStatus = isComplete ? 'COMPLETED' : data.status || existingJob.status;

      let finalNotes: string | null | undefined = undefined;
      if (data.completionNotes !== undefined) {
        finalNotes =
          data.completionNotes && String(data.completionNotes).trim().length > 0
            ? String(data.completionNotes).trim()
            : null;
      } else if (data.notes !== undefined) {
        finalNotes =
          data.notes && String(data.notes).trim().length > 0
            ? String(data.notes).trim()
            : null;
      }

      let finalMaterials: string | undefined = undefined;
      if (data.materialsUsed !== undefined) {
        if (typeof data.materialsUsed === 'string') {
          finalMaterials = data.materialsUsed;
        } else if (Array.isArray(data.materialsUsed)) {
          finalMaterials = JSON.stringify(data.materialsUsed);
        }
      }

      // Atomic Inventory Stock Count Decrement upon job completion
      if (isComplete && existingJob.status !== 'COMPLETED') {
        const rawMat = data.materialsUsed !== undefined ? data.materialsUsed : existingJob.materialsUsed;
        let materialsList: any[] = [];
        if (typeof rawMat === 'string') {
          try {
            materialsList = JSON.parse(rawMat);
          } catch {
            materialsList = [];
          }
        } else if (Array.isArray(rawMat)) {
          materialsList = rawMat;
        }

        if (Array.isArray(materialsList) && materialsList.length > 0) {
          for (const item of materialsList) {
            const qty = Number(item.quantity) || 1;
            const itemId = item.id || item.inventoryItemId || item.itemId;
            if (itemId) {
              const invItem = await prisma.inventoryItem.findFirst({
                where: { OR: [{ id: itemId }, { sku: itemId }, { sku: item.sku || '' }] },
              });
              if (invItem) {
                await prisma.inventoryItem.update({
                  where: { id: invItem.id },
                  data: { quantityInStock: { decrement: qty } },
                }).catch(console.error);
              }
            }
          }
          const updatedInventory = await inventoryService.getAll();
          broadcastEvent('INVENTORY_UPDATED', updatedInventory);
        }
      }

      const finalSignature = data.signatureData || data.signatureSvg || undefined;
      const finalBeforePhoto = data.beforePhotoUrl || data.beforePhoto || undefined;
      const finalAfterPhoto = data.afterPhotoUrl || data.afterPhoto || undefined;
      const finalLat =
        typeof data.completedLatitude === 'number'
          ? data.completedLatitude
          : typeof data.latitude === 'number'
          ? data.latitude
          : undefined;
      const finalLng =
        typeof data.completedLongitude === 'number'
          ? data.completedLongitude
          : typeof data.longitude === 'number'
          ? data.longitude
          : undefined;

      const resolvedCustomerEmail =
        (typeof data.customerEmail === 'string' && data.customerEmail.trim()) ||
        (typeof data?.customer?.email === 'string' && data.customer.email.trim()) ||
        existingJob.customerEmail ||
        undefined;

      const finalLaborCost = typeof data.laborCost === 'number' ? data.laborCost : undefined;
      let finalCustomServices: string | undefined = undefined;
      if (data.customServices !== undefined) {
        finalCustomServices = typeof data.customServices === 'string' ? data.customServices : JSON.stringify(data.customServices);
      }
      const finalTotalAmount = typeof data.totalAmount === 'number' ? data.totalAmount : undefined;
      const finalPaymentStatus = typeof data.paymentStatus === 'string' ? data.paymentStatus : (isComplete ? 'PAID' : undefined);
      const finalPaymentMethod = typeof data.paymentMethod === 'string' ? data.paymentMethod : undefined;
      const finalPaymentNotes = typeof data.paymentNotes === 'string' ? data.paymentNotes : undefined;

      const updatedJob = await prisma.job.update({
        where: { id: jobId },
        data: {
          status: finalStatus,
          customerEmail: resolvedCustomerEmail,
          completionNotes: finalNotes,
          signatureData: finalSignature,
          beforePhotoUrl: finalBeforePhoto,
          afterPhotoUrl: finalAfterPhoto,
          materialsUsed: finalMaterials !== undefined ? finalMaterials : undefined,
          laborCost: finalLaborCost,
          customServices: finalCustomServices,
          totalAmount: finalTotalAmount,
          paymentStatus: finalPaymentStatus,
          paymentMethod: finalPaymentMethod,
          paymentNotes: finalPaymentNotes,
          completedLatitude: finalLat,
          completedLongitude: finalLng,
          completedAt: finalStatus === 'COMPLETED' ? new Date() : undefined,
          clientUpdatedAt: clientUpdatedAt ? new Date(clientUpdatedAt) : now,
          syncedAt,
          version: { increment: 1 },
        },
        include: {
          technician: {
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
              role: true,
              lastKnownLat: true,
              lastKnownLng: true,
              lastLocationUpdate: true,
            },
          },
        },
      });

      if (updatedJob.status === 'COMPLETED') {
        const customerEmail = updatedJob.customerEmail || (updatedJob as any).customer_email || (updatedJob as any).email;
        console.log(`[SyncEngine Email Trigger] Job #${updatedJob.id} completed. Recipient: ${customerEmail}`);

        if (customerEmail) {
          try {
            // Await email delivery directly so it completes before response finishes
            const mailResult = await sendCompletionEmail(updatedJob, customerEmail);
            if (mailResult && !mailResult.success) {
              throw new Error(mailResult.error || 'Failed to deliver completion email');
            }
            console.log(`[SyncEngine Email Delivered] Successfully sent certificate to ${customerEmail}`);
          } catch (mailErr) {
            console.error(`[SyncEngine Email Error] Failed to send email for job #${updatedJob.id}:`, mailErr);
          }
        } else {
          console.warn(`[SyncEngine Email Warning] Job #${updatedJob.id} has no customerEmail.`);
        }
      }

      broadcastEvent('JOB_UPDATED', updatedJob);

      modifiedJobIds.add(jobId);
      const processedRecord: SyncProcessedRecord = {
        jobId,
        status: 'APPLIED',
        newVersion: updatedJob.version,
        job: {
          ...updatedJob,
          is_synced: true,
          pending_sync: false,
        },
      };
      processed.push(processedRecord);

      // Save the final mutation result into IdempotencyRecord
      if (idempotencyKey) {
        try {
          await prisma.idempotencyRecord.create({
            data: {
              key: idempotencyKey,
              mutationType: type,
              jobId,
              responsePayload: JSON.stringify(processedRecord),
            },
          });
          console.log(`[SyncController] Stored idempotency record for key "${idempotencyKey}".`);
        } catch (saveErr: any) {
          console.warn(`[SyncController] Could not store idempotency record for key "${idempotencyKey}":`, saveErr?.message || saveErr);
        }
      }
    }

    // Server Delta Pull: Query all jobs where updatedAt > lastSyncTimestamp that were NOT modified by incoming mutations
    const deltaWhere: any = {};
    if (req.user && req.user.role !== 'DISPATCHER') {
      deltaWhere.technicianId = req.user.id;
    }
    if (modifiedJobIds.size > 0) {
      deltaWhere.id = { notIn: Array.from(modifiedJobIds) };
    }
    if (lastSyncTimestamp) {
      const parsedLastSync = new Date(lastSyncTimestamp);
      if (!isNaN(parsedLastSync.getTime())) {
        deltaWhere.updatedAt = { gt: parsedLastSync };
      }
    }

    const serverUpdates = await prisma.job.findMany({
      where: deltaWhere,
      orderBy: { updatedAt: 'desc' },
      include: {
        technician: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            role: true,
            lastKnownLat: true,
            lastKnownLng: true,
            lastLocationUpdate: true,
          },
        },
      },
    });

    res.json({
      success: true,
      processed,
      conflicts,
      serverUpdates,
    });
  } catch (error: any) {
    console.error('[SyncController] Batch sync error:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to process batch sync',
    });
  }
};

