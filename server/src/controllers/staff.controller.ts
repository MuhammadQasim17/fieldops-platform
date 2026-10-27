import { Request, Response } from 'express';
import { prisma } from '../prisma';
import { broadcastEvent } from '../modules/events/events.service';
import { createTechnician, getTechnicians } from './dispatcher.controller';

export * from './dispatcher.controller';
export const createStaff = createTechnician;
export const getStaff = getTechnicians;

/**
 * DELETE /api/staff/:id & DELETE /api/technicians/:id
 * Enterprise soft-delete: Unassign active/pending jobs, mark staff as DEACTIVATED,
 * wipe password/token, broadcast STAFF_REMOVED, and preserve historical completed jobs.
 */
export const deleteStaff = async (req: Request, res: Response) => {
  try {
    const rawId = req.params.id;
    const staffId = (Array.isArray(rawId) ? rawId[0] : rawId)?.trim();
    if (!staffId) {
      return res.status(400).json({ error: 'Worker ID is required' });
    }

    const tech = await prisma.user.findFirst({
      where: {
        OR: [
          { id: staffId },
          { email: staffId.toLowerCase() },
          { email: staffId },
          { name: staffId },
        ],
      },
    });

    if (!tech) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    // 1. Unassign only pending/active jobs so other technicians can take them
    await prisma.job.updateMany({
      where: {
        technicianId: tech.id,
        status: { in: ['PENDING', 'EN_ROUTE', 'IN_PROGRESS'] },
      },
      data: { technicianId: null },
    });

    // 2. Instead of prisma.user.delete() which destroys relational history:
    // Mark their account as DEACTIVATED and wipe their password/token
    await prisma.user.update({
      where: { id: tech.id },
      data: {
        role: 'DEACTIVATED',
        password: 'ACCOUNT_DEACTIVATED_REVOKED',
      },
    });

    // 3. Immediately broadcast SSE event to notify and terminate active mobile client sessions
    broadcastEvent('STAFF_REMOVED', { technicianId: tech.id });

    return res.json({
      success: true,
      message: 'Worker deactivated and active jobs unassigned',
    });
  } catch (error) {
    console.error('Error deleting worker:', error);
    return res.status(500).json({ error: 'Failed to delete worker' });
  }
};
