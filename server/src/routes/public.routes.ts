import { Router, Request, Response } from 'express';
import { prisma } from '../prisma';
import { broadcastEvent } from '../modules/events/events.service';

const router = Router();

/**
 * POST /api/public/requests
 * Public customer booking request intake endpoint.
 * Unprotected by authentication middleware.
 */
router.post('/requests', async (req: Request, res: Response) => {
  try {
    const {
      customerName,
      customerEmail,
      customerPhone,
      customerAddress,
      title,
      description,
      priority,
    } = req.body || {};

    if (!customerName || !customerPhone || !customerAddress || !title || !description) {
      return res.status(400).json({
        error: 'Missing required booking fields: customerName, customerPhone, customerAddress, title, description',
      });
    }

    const newJob = await prisma.job.create({
      data: {
        customerName: String(customerName).trim(),
        customerEmail: customerEmail && String(customerEmail).trim() ? String(customerEmail).trim() : null,
        customerPhone: String(customerPhone).trim(),
        customerAddress: String(customerAddress).trim(),
        title: String(title).trim(),
        description: String(description).trim(),
        priority: priority || 'MEDIUM',
        status: 'PENDING',
        technicianId: null,
      },
      include: {
        technician: {
          select: { id: true, name: true, phone: true, email: true, role: true },
        },
      },
    });

    broadcastEvent('JOB_CREATED', newJob);
    broadcastEvent('JOB_UPDATED', newJob);

    return res.status(201).json({
      success: true,
      trackingId: newJob.id,
      job: newJob,
    });
  } catch (error: any) {
    console.error('[PublicBooking] Error creating service request:', error);
    return res.status(500).json({
      error: 'Failed to submit service request. Please try again.',
    });
  }
});

/**
 * GET /api/public/requests/:id
 * Public customer booking status lookup.
 */
router.get(['/requests/:id', '/status/:id', '/jobs/:id'], async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const job = await prisma.job.findUnique({
      where: { id },
      include: {
        technician: {
          select: { id: true, name: true, phone: true, email: true, role: true },
        },
      },
    });

    if (!job) {
      return res.status(404).json({ error: 'Service request not found' });
    }

    return res.json({
      success: true,
      trackingId: job.id,
      job,
    });
  } catch (error: any) {
    console.error('[PublicBooking] Error fetching request status:', error);
    return res.status(500).json({
      error: 'Failed to retrieve service request status.',
    });
  }
});

export default router;

