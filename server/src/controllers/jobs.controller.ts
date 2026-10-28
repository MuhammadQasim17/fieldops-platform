import { Request, Response } from 'express';
import { prisma } from '../prisma';
import { generateJobPdf } from '../modules/jobs/pdf.service';
import { inventoryService, MaterialUsedRecord } from '../modules/inventory/inventory.service';
import { sendCompletionEmail, sendDispatchEmail, sendJobNotificationEmail } from '../services/email.service';
import { broadcastEvent } from '../modules/events/events.service';
import { settingsService } from '../services/settings.service';

/**
 * GET /api/jobs
 * Fetch jobs with optional status/priority filtering
 */
export const getJobs = async (req: Request, res: Response) => {
  const { status, priority, technicianId, assignedTechId } = req.query;

  try {
    // Check if worker account exists and is not deactivated when assignedTechId or technicianId is provided
    const techQueryId = (assignedTechId ||
      technicianId ||
      (req.user && req.user.role !== 'DISPATCHER' ? req.user.id : undefined)) as string | undefined;

    if (
      techQueryId &&
      typeof techQueryId === 'string' &&
      techQueryId !== 'ALL' &&
      techQueryId !== 'dispatcher-local-session'
    ) {
      const user = await prisma.user.findUnique({
        where: { id: techQueryId },
      });
      if (!user || user.role === 'DEACTIVATED') {
        return res.status(403).json({
          error: 'NOT_A_MEMBER',
          message: 'Account deactivated. You are no longer authorized to view work orders.',
        });
      }
    }

    const where: any = {};
    if (status && typeof status === 'string' && status !== 'ALL') {
      where.status = status;
    }
    if (priority && typeof priority === 'string' && priority !== 'ALL') {
      where.priority = priority;
    }
    const techIdFilter = (assignedTechId ||
      technicianId ||
      (req.user && req.user.role !== 'DISPATCHER' ? req.user.id : undefined)) as
      | string
      | undefined;
    if (techIdFilter && typeof techIdFilter === 'string' && techIdFilter !== 'ALL') {
      where.technicianId = techIdFilter;
    }

    const defaultLabor = await settingsService.getBaseLaborFee();

    const jobs = await prisma.job.findMany({
      where,
      orderBy: { createdAt: 'desc' },
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

    const mappedJobs = jobs.map((job) => {
      const laborCost =
        job.status === 'COMPLETED' && typeof job.laborCost === 'number' && job.laborCost >= 0
          ? job.laborCost
          : defaultLabor;

      const staffDetails = job.technician
        ? {
            ...job.technician,
            fullName: job.technician.name,
          }
        : null;

      const staffId = job.technicianId || job.technician?.id || null;

      return {
        ...job,
        assignedTechId: staffId,
        assignedStaffId: staffId,
        assignedStaff: staffDetails,
        assignedUser: staffDetails,
        laborCost,
      };
    });

    res.json(mappedJobs);
  } catch (error) {
    console.error('Error fetching jobs:', error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
};

/**
 * POST /api/jobs
 * Create and assign a new job to a technician
 */
export const createJob = async (req: Request, res: Response) => {
  const {
    title,
    description,
    customerName,
    customerPhone,
    customerAddress,
    customerEmail,
    priority,
    technicianId,
    latitude,
    longitude,
  } = req.body;

  console.log('[Create Job] Incoming customer email:', req.body.customerEmail || req.body.email);

  try {
    const rawCustomerEmail = (customerEmail || req.body.email || req.body.customer_email || '').trim();
    const resolvedCustomerEmail = rawCustomerEmail.length > 0 ? rawCustomerEmail : undefined;
    const defaultLabor = await settingsService.getBaseLaborFee();
    const resolvedLaborCost = typeof req.body.laborCost === 'number' ? req.body.laborCost : defaultLabor;
    const resolvedTotalAmount = typeof req.body.totalAmount === 'number' ? req.body.totalAmount : resolvedLaborCost;

    let sanitizedPriority: 'LOW' | 'MEDIUM' | 'HIGH' | 'EMERGENCY' = 'MEDIUM';
    if (priority && typeof priority === 'string') {
      const upper = priority.toUpperCase();
      if (upper.includes('EMERGENCY')) sanitizedPriority = 'EMERGENCY';
      else if (upper.includes('HIGH')) sanitizedPriority = 'HIGH';
      else if (upper.includes('LOW')) sanitizedPriority = 'LOW';
      else sanitizedPriority = 'MEDIUM';
    }

    const rawTechId =
      req.body.assignedStaffId || req.body.assignedTechId || technicianId || undefined;

    const newJob = await prisma.job.create({
      data: {
        title,
        description,
        customerName,
        customerPhone,
        customerAddress,
        customerEmail: resolvedCustomerEmail,
        priority: sanitizedPriority,
        status: 'PENDING',
        technicianId: rawTechId || undefined,
        latitude: latitude ? parseFloat(latitude) : undefined,
        longitude: longitude ? parseFloat(longitude) : undefined,
        laborCost: resolvedLaborCost,
        totalAmount: resolvedTotalAmount,
      },
      include: {
        technician: {
          select: { id: true, name: true, phone: true, email: true, role: true },
        },
      },
    });

    const staffDetails = newJob.technician
      ? {
          ...newJob.technician,
          fullName: newJob.technician.name,
        }
      : null;
    const staffId = newJob.technicianId || newJob.technician?.id || null;

    const formattedJob = {
      ...newJob,
      assignedTechId: staffId,
      assignedStaffId: staffId,
      assignedStaff: staffDetails,
      assignedUser: staffDetails,
    };

    broadcastEvent('JOB_CREATED', formattedJob);
    broadcastEvent('JOB_ASSIGNED', formattedJob);
    broadcastEvent('JOB_UPDATED', formattedJob);
    broadcastEvent('NEW_JOB', formattedJob);

    // Dispatch confirmation email asynchronously so HTTP response returns immediately without hanging
    if (resolvedCustomerEmail) {
      sendDispatchEmail(newJob)
        .then((res) => console.log('[Job Created] Email dispatch result:', JSON.stringify(res)))
        .catch((err) => console.error('[Job Created] Email error:', err));
    }

    return res.status(201).json({ success: true, job: formattedJob, ...formattedJob });
  } catch (error: any) {
    console.error('Error creating job:', error);
    const statusCode = error?.statusCode || error?.status || 500;
    const errorMessage = error?.message || 'Failed to create work order';
    return res.status(statusCode).json({ error: errorMessage });
  }
};

/**
 * GET /api/jobs/:id
 * Fetch a single job by ID
 */
export const getJobById = async (req: Request, res: Response) => {
  const rawId = String(req.params.id || '').trim().replace(/^#/, '');

  try {
    let job = await prisma.job.findUnique({
      where: { id: rawId },
      include: {
        technician: {
          select: { id: true, name: true, phone: true, email: true, role: true, lastKnownLat: true, lastKnownLng: true },
        },
      },
    });

    if (!job && rawId.length >= 6 && rawId.length <= 32) {
      const cleanSearch = rawId.toLowerCase();
      const allJobs = await prisma.job.findMany({
        take: 100,
        orderBy: { createdAt: 'desc' },
        include: {
          technician: {
            select: { id: true, name: true, phone: true, email: true, role: true, lastKnownLat: true, lastKnownLng: true },
          },
        },
      });
      job = allJobs.find((j) => j.id.replace(/-/g, '').toLowerCase().startsWith(cleanSearch)) || null;
    }

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const defaultLabor = await settingsService.getBaseLaborFee();
    const resolvedLaborCost =
      job.status === 'COMPLETED' && typeof job.laborCost === 'number' && job.laborCost >= 0
        ? job.laborCost
        : defaultLabor;

    const staffDetails = job.technician
      ? {
          ...job.technician,
          fullName: job.technician.name,
        }
      : null;
    const staffId = job.technicianId || job.technician?.id || null;

    res.json({
      ...job,
      assignedTechId: staffId,
      assignedStaffId: staffId,
      assignedStaff: staffDetails,
      assignedUser: staffDetails,
      laborCost: resolvedLaborCost,
    });
  } catch (error) {
    console.error('Error fetching job details:', error);
    res.status(500).json({ error: 'Failed to fetch job details' });
  }
};

/**
 * PATCH /api/jobs/:id
 * Update job status, completion notes, and customer signature
 */
export const updateJob = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const {
    status,
    technicianId,
    customerEmail,
    completionNotes,
    notes,
    signatureData,
    signatureSvg,
    clientUpdatedAt,
    completedLatitude,
    completedLongitude,
    latitude,
    longitude,
    beforePhoto,
    beforePhotoUrl,
    afterPhoto,
    afterPhotoUrl,
    materialsUsed,
    laborCost,
    customServices,
    totalAmount,
    paymentStatus,
    paymentMethod,
    paymentNotes,
  } = req.body;

  const rawVersion =
    req.body.clientVersion !== undefined
      ? req.body.clientVersion
      : req.body.expectedVersion !== undefined
      ? req.body.expectedVersion
      : req.body.version;
  const clientVersion =
    typeof rawVersion === 'number'
      ? rawVersion
      : typeof rawVersion === 'string' && !isNaN(parseInt(rawVersion, 10))
      ? parseInt(rawVersion, 10)
      : undefined;

  try {
    const existingWorkOrder = await prisma.job.findUnique({
      where: { id },
      include: {
        technician: {
          select: { id: true, name: true, phone: true, email: true, role: true },
        },
      },
    });

    if (!existingWorkOrder) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Optimistic Concurrency Control (OCC) Check:
    // If client provided a version and clientVersion < existingWorkOrder.version,
    // evaluate whether the server state has incompatible dispatcher modifications
    if (typeof clientVersion === 'number' && clientVersion < existingWorkOrder.version) {
      const isCancelled = existingWorkOrder.status === 'CANCELLED';
      const authenticatedUser = (req as any).user;
      const isReassigned =
        existingWorkOrder.technicianId &&
        authenticatedUser &&
        authenticatedUser.role === 'TECHNICIAN' &&
        existingWorkOrder.technicianId !== authenticatedUser.id;

      if (isCancelled || isReassigned) {
        console.warn(
          `[OCC Conflict] Incompatible conflict on job ${id}: clientVersion=${clientVersion} < serverVersion=${existingWorkOrder.version} (cancelled=${isCancelled}, reassigned=${isReassigned})`
        );
        return res.status(409).json({
          error: 'VERSION_MISMATCH',
          conflictReason: isCancelled ? 'JOB_CANCELLED' : 'JOB_REASSIGNED',
          message: isCancelled
            ? 'This work order has been cancelled by the dispatcher.'
            : 'This work order has been reassigned to another technician.',
          serverJob: existingWorkOrder,
        });
      }
    }

    const isComplete = req.path.includes('/complete') || req.originalUrl?.includes('/complete') || status === 'COMPLETED';
    const finalStatus = isComplete ? 'COMPLETED' : status || undefined;
    
    // Do not use any default fallback text; save null if empty or undefined
    let finalNotes: string | null | undefined = undefined;
    if (completionNotes !== undefined) {
      finalNotes = completionNotes && completionNotes.trim().length > 0 ? completionNotes.trim() : null;
    } else if (notes !== undefined) {
      finalNotes = notes && notes.trim().length > 0 ? notes.trim() : null;
    }

    const rawTechId =
      req.body.assignedStaffId !== undefined
        ? req.body.assignedStaffId
        : req.body.assignedTechId !== undefined
        ? req.body.assignedTechId
        : technicianId;
    const resolvedTechnicianId = rawTechId !== undefined ? (rawTechId || null) : undefined;
    const previousTechId = existingWorkOrder.technicianId;

    let finalMaterials: string | undefined = undefined;
    if (materialsUsed !== undefined) {
      if (typeof materialsUsed === 'string') {
        finalMaterials = materialsUsed;
      } else if (Array.isArray(materialsUsed)) {
        finalMaterials = JSON.stringify(materialsUsed);
      }
    }

    // Atomic Inventory Stock Count Decrement upon job completion
    if (isComplete && existingWorkOrder.status !== 'COMPLETED') {
      const rawMat = materialsUsed !== undefined ? materialsUsed : existingWorkOrder.materialsUsed;
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

    const finalLaborCost = typeof laborCost === 'number' ? laborCost : (typeof laborCost === 'string' && !isNaN(parseFloat(laborCost)) ? parseFloat(laborCost) : undefined);
    let finalCustomServices: string | undefined = undefined;
    if (customServices !== undefined) {
      finalCustomServices = typeof customServices === 'string' ? customServices : JSON.stringify(customServices);
    }
    let finalTotalAmount = typeof totalAmount === 'number' ? totalAmount : (typeof totalAmount === 'string' && !isNaN(parseFloat(totalAmount)) ? parseFloat(totalAmount) : undefined);
    if (finalLaborCost !== undefined && finalTotalAmount === undefined) {
      let partsTotal = 0;
      const matSrc = finalMaterials !== undefined ? finalMaterials : existingWorkOrder.materialsUsed;
      if (matSrc) {
        try {
          const parsed = JSON.parse(matSrc);
          if (Array.isArray(parsed)) {
            partsTotal = parsed.reduce((sum: number, item: any) => sum + (Number(item.totalCost) || (Number(item.unitCost || 0) * Number(item.quantity || 1))), 0);
          }
        } catch {}
      }

      let customTotal = 0;
      const custSrc = finalCustomServices !== undefined ? finalCustomServices : existingWorkOrder.customServices;
      if (custSrc) {
        try {
          const parsed = JSON.parse(custSrc);
          if (Array.isArray(parsed)) {
            customTotal = parsed.reduce((sum: number, item: any) => sum + Number(item.amount || 0), 0);
          }
        } catch {}
      }

      finalTotalAmount = Number((finalLaborCost + partsTotal + customTotal).toFixed(2));
    }
    const finalPaymentStatus = typeof paymentStatus === 'string' ? paymentStatus : (isComplete ? 'PAID' : undefined);
    const finalPaymentMethod = typeof paymentMethod === 'string' ? paymentMethod : undefined;
    const finalPaymentNotes = typeof paymentNotes === 'string' ? paymentNotes : undefined;

    const finalSignature = signatureData || signatureSvg || undefined;
    const finalBeforePhoto = beforePhotoUrl || beforePhoto || undefined;
    const finalAfterPhoto = afterPhotoUrl || afterPhoto || undefined;
    const finalLat =
      typeof completedLatitude === 'number'
        ? completedLatitude
        : typeof latitude === 'number'
        ? latitude
        : undefined;
    const finalLng =
      typeof completedLongitude === 'number'
        ? completedLongitude
        : typeof longitude === 'number'
        ? longitude
        : undefined;

    const now = new Date();
    let syncedAt = now;
    if (clientUpdatedAt) {
      const clientDate = new Date(clientUpdatedAt);
      if (!isNaN(clientDate.getTime()) && clientDate.getTime() >= now.getTime()) {
        syncedAt = new Date(clientDate.getTime() + 1000);
      }
    }

    // Preserve existing customerEmail from Prisma unless a valid non-empty email is provided in payload
    const resolvedCustomerEmail =
      (typeof customerEmail === 'string' && customerEmail.trim()) ||
      (typeof req.body?.customer?.email === 'string' && req.body.customer.email.trim()) ||
      existingWorkOrder.customerEmail ||
      undefined;

    const updatedJob = await prisma.job.update({
      where: { id },
      data: {
        status: finalStatus,
        technicianId: resolvedTechnicianId,
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
        clientUpdatedAt: clientUpdatedAt ? new Date(clientUpdatedAt) : undefined,
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

    // Automatically trigger resolution completion email with direct link to PDF certificate asynchronously
    if (updatedJob.status === 'COMPLETED') {
      const customerEmail = updatedJob.customerEmail || (updatedJob as any).customer_email || (updatedJob as any).email;
      console.log(`[SyncEngine Email Trigger] Job #${updatedJob.id} completed. Recipient: ${customerEmail}`);

      if (customerEmail) {
        sendCompletionEmail(updatedJob, customerEmail)
          .then(async (mailResult) => {
            if (mailResult && mailResult.success) {
              console.log(`[SyncEngine Email Delivered] Successfully sent certificate to ${customerEmail}`);
              await prisma.job.update({ where: { id: updatedJob.id }, data: { completionEmailSent: true } }).catch(() => {});
            }
          })
          .catch((mailErr) => {
            console.error(`[SyncEngine Email Error] Failed to send email for job #${updatedJob.id}:`, mailErr);
          });
      } else {
        console.warn(`[SyncEngine Email Warning] Job #${updatedJob.id} has no customerEmail.`);
      }
    }

    // Trigger scheduling/dispatch email notification asynchronously if job scheduled or newly assigned
    const isNewlyAssigned = resolvedTechnicianId !== undefined && resolvedTechnicianId !== existingWorkOrder.technicianId;
    const isScheduled = Boolean(req.body?.scheduledDate || req.body?.scheduledTime);
    if ((isNewlyAssigned || isScheduled) && updatedJob.status !== 'COMPLETED' && updatedJob.customerEmail) {
      sendDispatchEmail(updatedJob)
        .then((res) => {
          if (res?.success) {
            console.log(`[Job Updated] Schedule confirmation email sent to ${updatedJob.customerEmail}`);
          }
        })
        .catch((err) => {
          console.error('[Job Updated] Error sending schedule confirmation email:', err);
        });
    }

    const staffDetails = updatedJob.technician
      ? {
          ...updatedJob.technician,
          fullName: updatedJob.technician.name,
        }
      : null;
    const staffId = updatedJob.technicianId || updatedJob.technician?.id || null;

    const formattedUpdatedJob = {
      ...updatedJob,
      assignedTechId: staffId,
      assignedStaffId: staffId,
      assignedStaff: staffDetails,
      assignedUser: staffDetails,
      is_synced: true,
      pending_sync: false,
    };

    if (resolvedTechnicianId !== undefined) {
      const reassignmentPayload = {
        jobId: id,
        assignedTechId: resolvedTechnicianId,
        assignedStaffId: resolvedTechnicianId,
        previousTechId,
        job: formattedUpdatedJob,
        ...formattedUpdatedJob,
      };
      broadcastEvent('JOB_REASSIGNED', reassignmentPayload);
      broadcastEvent('JOB_UPDATED', reassignmentPayload);
      broadcastEvent('JOB_ASSIGNED', formattedUpdatedJob);
    } else {
      broadcastEvent('JOB_UPDATED', formattedUpdatedJob);
    }

    res.json(formattedUpdatedJob);
  } catch (error) {
    console.error('Error updating job:', error);
    res.status(500).json({ error: 'Failed to update job' });
  }
};

/**
 * GET /api/jobs/:id/pdf
 * Stream or send the generated Work Order Resolution Certificate PDF
 */
export const getJobPdf = async (req: Request, res: Response) => {
  const rawId = String(req.params.id || '').trim().replace(/^#/, '');

  try {
    let job = await prisma.job.findUnique({
      where: { id: rawId },
      include: {
        technician: {
          select: { id: true, name: true, phone: true, email: true, role: true },
        },
      },
    });

    if (!job && rawId.length >= 6 && rawId.length <= 32) {
      const cleanSearch = rawId.toLowerCase();
      const allJobs = await prisma.job.findMany({
        take: 100,
        orderBy: { createdAt: 'desc' },
        include: {
          technician: {
            select: { id: true, name: true, phone: true, email: true, role: true },
          },
        },
      });
      job = allJobs.find((j) => j.id.replace(/-/g, '').toLowerCase().startsWith(cleanSearch)) || null;
    }

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const pdfBuffer = await generateJobPdf(job);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="WorkOrder-${job.id}.pdf"`
    );
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);
  } catch (error) {
    console.error('Error generating job PDF certificate:', error);
    res.status(500).json({ error: 'Failed to generate PDF certificate' });
  }
};

/**
 * PATCH /api/jobs/:id/location
 * Store the latest technician coordinates on the job record and active staff member
 */
export const updateJobLocation = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { latitude, longitude, lat, lng, timestamp } = req.body;

  const rawLat = latitude !== undefined && latitude !== null ? latitude : lat;
  const rawLng = longitude !== undefined && longitude !== null ? longitude : lng;

  const numLat = typeof rawLat === 'string' ? parseFloat(rawLat) : rawLat;
  const numLng = typeof rawLng === 'string' ? parseFloat(rawLng) : rawLng;

  if (typeof numLat !== 'number' || isNaN(numLat) || typeof numLng !== 'number' || isNaN(numLng)) {
    return res.status(400).json({ error: 'Valid numeric latitude and longitude coordinates are required' });
  }

  const locationTime = timestamp ? new Date(timestamp) : new Date();

  try {
    const existingJob = await prisma.job.findUnique({
      where: { id },
      select: { id: true, technicianId: true },
    });

    if (!existingJob) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const updatedJob = await prisma.job.update({
      where: { id },
      data: {
        lastKnownLat: numLat,
        lastKnownLng: numLng,
        lastLocationUpdate: locationTime,
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

    if (existingJob.technicianId) {
      await prisma.user.update({
        where: { id: existingJob.technicianId },
        data: {
          lastKnownLat: numLat,
          lastKnownLng: numLng,
          lastLocationUpdate: locationTime,
        },
      }).catch((err) => {
        console.warn('Could not update user location record:', err);
      });
    }

    broadcastEvent('TECH_LOCATION_UPDATED', {
      jobId: id,
      technicianId: existingJob.technicianId,
      lat: numLat,
      lng: numLng,
      timestamp: locationTime.toISOString(),
    });
    broadcastEvent('JOB_UPDATED', updatedJob);

    res.json({
      success: true,
      jobId: id,
      latitude: numLat,
      longitude: numLng,
      lastLocationUpdate: locationTime,
      job: updatedJob,
    });
  } catch (error) {
    console.error('Error updating job location:', error);
    res.status(500).json({ error: 'Failed to update job location' });
  }
};

/**
 * POST /api/jobs/:id/materials
 * Add parts/materials used to a job and deduct stockQty from truck inventory
 */
export const addJobMaterials = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const items = req.body.items || req.body.materials || [];

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Items array is required with at least one item' });
  }

  try {
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Deduct stock from inventory
    const deductedRecords = await inventoryService.deductMaterials(items);

    // Merge with any existing materialsUsed on this job
    let existingMaterials: MaterialUsedRecord[] = [];
    if (job.materialsUsed) {
      try {
        existingMaterials = JSON.parse(job.materialsUsed);
      } catch {
        existingMaterials = [];
      }
    }

    const mergedMaterials = [...existingMaterials, ...deductedRecords];
    const totalPartsCost = Number(
      mergedMaterials.reduce((acc, curr) => acc + (curr.totalCost || curr.unitCost * curr.quantity || 0), 0).toFixed(2)
    );

    const updatedJob = await prisma.job.update({
      where: { id },
      data: {
        materialsUsed: JSON.stringify(mergedMaterials),
        version: { increment: 1 },
      },
      include: {
        technician: {
          select: { id: true, name: true, phone: true, email: true, role: true },
        },
      },
    });

    broadcastEvent('JOB_UPDATED', updatedJob);
    const updatedInventory = await inventoryService.getAll();
    broadcastEvent('INVENTORY_UPDATED', updatedInventory);

    res.json({
      success: true,
      jobId: id,
      materialsUsed: mergedMaterials,
      totalPartsCost,
      job: updatedJob,
    });
  } catch (error) {
    console.error('Error adding job materials:', error);
    res.status(500).json({ error: 'Failed to add materials to job' });
  }
};

/**
 * DELETE /api/jobs/:id/materials/:itemId
 * Remove a material line item from a job and increment/restore inventory
 */
export const removeJobMaterial = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const itemId = req.params.itemId as string;

  try {
    const job = await prisma.job.findUnique({
      where: { id },
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    let existingMaterials: MaterialUsedRecord[] = [];
    if (job.materialsUsed) {
      try {
        existingMaterials = JSON.parse(job.materialsUsed);
      } catch {
        existingMaterials = [];
      }
    }

    const removedItem = existingMaterials.find((m) => m.itemId === itemId || m.sku === itemId);
    if (!removedItem) {
      return res.status(404).json({ error: 'Material item not found on this job' });
    }

    // Increment inventory stock count back atomically
    await inventoryService.restoreMaterials([{ itemId: removedItem.itemId || removedItem.sku, quantity: removedItem.quantity }]);

    const remainingMaterials = existingMaterials.filter((m) => m.itemId !== itemId && m.sku !== itemId);
    const totalPartsCost = Number(remainingMaterials.reduce((acc, m) => acc + (m.totalCost || 0), 0).toFixed(2));

    const updatedJob = await prisma.job.update({
      where: { id },
      data: {
        materialsUsed: JSON.stringify(remainingMaterials),
        version: { increment: 1 },
      },
      include: {
        technician: {
          select: { id: true, name: true, phone: true, email: true, role: true },
        },
      },
    });

    broadcastEvent('JOB_UPDATED', updatedJob);
    const updatedInventory = await inventoryService.getAll();
    broadcastEvent('INVENTORY_UPDATED', updatedInventory);

    res.json({
      success: true,
      jobId: id,
      materialsUsed: remainingMaterials,
      totalPartsCost,
      job: updatedJob,
    });
  } catch (error) {
    console.error('Error removing materials from job:', error);
    res.status(500).json({ error: 'Failed to remove material from job' });
  }
};

/**
 * POST /api/jobs/:id/resend-email & POST /api/jobs/:id/send-email
 * Dispatcher manual action to send / re-send the completion certificate email to the customer
 */
export const resendJobEmail = async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { customerEmail } = req.body || {};

  try {
    const job = await prisma.job.findUnique({
      where: { id },
      include: {
        technician: {
          select: { id: true, name: true, phone: true, email: true, role: true },
        },
      },
    });

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const recipient = ((customerEmail && typeof customerEmail === 'string' && customerEmail.trim()) || job.customerEmail || '').trim();

    if (!recipient) {
      return res.status(400).json({ error: 'No customer email found for this work order.' });
    }

    if (customerEmail && typeof customerEmail === 'string' && customerEmail.trim() !== job.customerEmail) {
      await prisma.job.update({
        where: { id },
        data: { customerEmail: recipient },
      });
      job.customerEmail = recipient;
    }

    const emailResult = await sendCompletionEmail(job, recipient);

    return res.json({
      success: true,
      message: `Completion email successfully sent to ${recipient}`,
      recipient,
      previewUrl: emailResult?.previewUrl || null,
    });
  } catch (error: any) {
    console.error('Error sending job completion email:', error);
    const errorMessage = error?.message || 'Failed to send completion email';
    return res.status(500).json({ error: errorMessage });
  }
};

export const getAssignedJobs = getJobs;


