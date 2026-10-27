import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../prisma';
import { settingsService } from '../services/settings.service';
import { transporter } from '../modules/notifications/email.service';
import { broadcastEvent } from '../modules/events/events.service';

/**
 * GET /api/dispatcher/metrics
 * Aggregate real-time operations metrics for dispatcher dashboard
 */
export const getDispatcherMetrics = async (req: Request, res: Response) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalJobs,
      completedToday,
      enRoute,
      inProgress,
      pending,
      emergencyJobs,
      highPriorityJobs,
      priorityGroups,
      statusGroups,
    ] = await Promise.all([
      prisma.job.count(),
      prisma.job.count({
        where: {
          status: 'COMPLETED',
          completedAt: { gte: today },
        },
      }),
      prisma.job.count({ where: { status: 'EN_ROUTE' } }),
      prisma.job.count({ where: { status: 'IN_PROGRESS' } }),
      prisma.job.count({ where: { status: 'PENDING' } }),
      prisma.job.count({
        where: {
          priority: 'EMERGENCY',
          status: { not: 'COMPLETED' },
        },
      }),
      prisma.job.count({
        where: {
          priority: 'HIGH',
          status: { not: 'COMPLETED' },
        },
      }),
      prisma.job.groupBy({
        by: ['priority'],
        _count: { _all: true },
      }),
      prisma.job.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    const activeDispatches = enRoute + inProgress;
    const urgentAlerts = emergencyJobs + highPriorityJobs;

    const priorityBreakdown = priorityGroups.reduce(
      (acc, item) => {
        acc[item.priority] = item._count._all;
        return acc;
      },
      { EMERGENCY: 0, HIGH: 0, MEDIUM: 0, LOW: 0 } as Record<string, number>
    );

    const statusBreakdown = statusGroups.reduce(
      (acc, item) => {
        acc[item.status] = item._count._all;
        return acc;
      },
      { PENDING: 0, EN_ROUTE: 0, IN_PROGRESS: 0, COMPLETED: 0, CANCELLED: 0 } as Record<string, number>
    );

    res.json({
      totalJobs,
      activeDispatches,
      pendingOrders: pending,
      completedToday,
      enRoute,
      inProgress,
      emergencyJobs,
      highPriorityJobs,
      urgentAlerts,
      priorityBreakdown,
      statusBreakdown,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching dispatcher metrics:', error);
    res.status(500).json({ error: 'Failed to aggregate dispatcher metrics' });
  }
};

/**
 * GET /api/technicians (or /api/users)
 * Return list of all field team members and count of currently active jobs
 */
export const getTechnicians = async (req: Request, res: Response) => {
  try {
    const { role } = req.query;
    const whereClause: any = {
      role: { notIn: ['DISPATCHER', 'DEACTIVATED'] },
    };

    if (role && typeof role === 'string' && role !== 'ALL') {
      whereClause.role = role;
    }

    const technicians = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        createdAt: true,
        assignedJobs: {
          where: {
            status: { in: ['PENDING', 'EN_ROUTE', 'IN_PROGRESS'] },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            priority: true,
            status: true,
            customerName: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const formatted = technicians.map((tech) => ({
      id: tech.id,
      name: tech.name,
      email: tech.email,
      phone: tech.phone,
      role: tech.role,
      status: 'Active',
      createdAt: tech.createdAt,
      activeJobsCount: tech.assignedJobs.length,
      activeJobs: tech.assignedJobs,
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching technicians:', error);
    res.status(500).json({ error: 'Failed to retrieve team members' });
  }
};

/**
 * Send welcome email with login credentials to technician
 */
export async function sendWelcomeEmail(toEmail: string, name: string, plainPassword: string) {
  await transporter.sendMail({
    from: process.env.SMTP_FROM || '"FieldOps Dispatch" <fieldops.dispatch@gmail.com>',
    to: toEmail,
    subject: 'Welcome to FieldOps - Your Mobile App Login Credentials',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #E2E8F0; border-radius: 8px;">
        <h2 style="color: #1E293B; margin-top: 0;">Welcome to the FieldOps Team</h2>
        <p style="color: #475569; font-size: 15px;">Hello ${name},</p>
        <p style="color: #475569; font-size: 15px;">Your field technician account has been provisioned. Use the following credentials to sign in to the FieldOps mobile application:</p>
        <div style="background-color: #F8FAFC; border: 1px solid #CBD5E1; border-radius: 6px; padding: 16px; margin: 20px 0;">
          <p style="margin: 0 0 8px 0; color: #334155; font-size: 14px;"><strong>Work Email:</strong> ${toEmail}</p>
          <p style="margin: 0; color: #334155; font-size: 14px;"><strong>Temporary Password:</strong> <code style="background-color: #E2E8F0; padding: 2px 6px; border-radius: 4px;">${plainPassword}</code></p>
        </div>
        <p style="color: #64748B; font-size: 13px;">Please launch the FieldOps app on your mobile device to view your active work orders.</p>
      </div>
    `,
  });
}

/**
 * POST /api/dispatcher/technicians (and /api/technicians, /api/staff)
 * Register/provision a new field technician or re-activate a previously deactivated staff member
 */
export const createTechnician = async (req: Request, res: Response) => {
  try {
    const { name, email, phone, role, password } = req.body;
    const cleanEmail = String(email || '').trim().toLowerCase();

    const rawTemporaryPassword =
      password && typeof password === 'string' && password.trim().length > 0
        ? password.trim()
        : 'password123';

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanEmail },
          { email: String(email || '').trim() },
        ],
      },
    });

    if (existingUser) {
      // If the user was previously deactivated/removed, RE-ACTIVATE them
      if (existingUser.role === 'DEACTIVATED') {
        const hashedPassword = await bcrypt.hash(rawTemporaryPassword, 10);
        const reactivatedUser = await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            name: String(name || existingUser.name).trim(),
            phone: phone ? String(phone).trim() : existingUser.phone,
            role: role || 'TECHNICIAN',
            password: hashedPassword,
          },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
            createdAt: true,
          },
        });

        // Send onboarding credentials email
        try {
          await sendWelcomeEmail(reactivatedUser.email, reactivatedUser.name, rawTemporaryPassword);
          console.log(`[StaffController] Re-activation welcome email sent to ${reactivatedUser.email}`);
        } catch (mailErr) {
          console.warn('Re-activation email notice:', mailErr);
        }

        return res.status(200).json({
          success: true,
          message: 'Staff member re-activated successfully',
          technician: reactivatedUser,
          ...reactivatedUser,
          temporaryPassword: rawTemporaryPassword,
          activeJobsCount: 0,
          activeJobs: [],
        });
      }

      // Only return an error if they are ALREADY an active staff member
      return res.status(400).json({
        success: false,
        error: 'A technician with this email already exists in the active roster',
      });
    }

    const hashedPassword = await bcrypt.hash(rawTemporaryPassword, 10);

    const technician = await prisma.user.create({
      data: {
        name: String(name).trim(),
        email: cleanEmail,
        phone: phone ? String(phone).trim() : null,
        role: role || 'TECHNICIAN',
        password: hashedPassword,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        createdAt: true,
      },
    });

    try {
      await sendWelcomeEmail(technician.email, technician.name, rawTemporaryPassword);
      console.log(`[StaffController] Welcome email successfully sent to ${technician.email}`);
    } catch (mailError) {
      console.warn('[StaffController] Welcome email dispatch failed:', mailError);
    }

    return res.status(201).json({
      success: true,
      message: 'Staff member created successfully',
      technician,
      ...technician,
      temporaryPassword: rawTemporaryPassword,
      activeJobsCount: 0,
      activeJobs: [],
    });
  } catch (error) {
    console.error('Error creating technician:', error);
    return res.status(500).json({ error: 'Failed to create technician' });
  }
};

/**
 * GET /api/dispatcher/settings
 * Fetch global system settings (e.g. defaultBaseLaborFee)
 */
export const getDispatcherSettings = async (req: Request, res: Response) => {
  try {
    const baseLaborFee = await settingsService.getBaseLaborFee();
    res.json({
      baseLaborFee,
      defaultBaseLaborFee: baseLaborFee,
    });
  } catch (error) {
    console.error('Error getting dispatcher settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
};

/**
 * POST /api/dispatcher/settings
 * Update global system settings (e.g. defaultBaseLaborFee)
 */
export const updateDispatcherSettings = async (req: Request, res: Response) => {
  try {
    const { baseLaborFee, defaultBaseLaborFee } = req.body;
    const rawFee = baseLaborFee !== undefined ? baseLaborFee : defaultBaseLaborFee;
    const fee = typeof rawFee === 'number' ? rawFee : parseFloat(rawFee);
    if (isNaN(fee) || fee < 0) {
      return res.status(400).json({ error: 'Invalid baseLaborFee provided' });
    }
    const updatedFee = await settingsService.setBaseLaborFee(fee);

    // Update active non-completed jobs in DB so their laborCost reflects the updated fee
    await prisma.job.updateMany({
      where: {
        status: { in: ['PENDING', 'EN_ROUTE', 'IN_PROGRESS'] },
      },
      data: {
        laborCost: updatedFee,
      },
    }).catch((err) => {
      console.warn('Failed to update active jobs laborCost:', err);
    });

    res.json({
      success: true,
      baseLaborFee: updatedFee,
      defaultBaseLaborFee: updatedFee,
    });
  } catch (error) {
    console.error('Error updating dispatcher settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
};

/**
 * DELETE /api/staff/:id or /api/technicians/:id
 * Enterprise soft-delete: Unassign active/pending jobs, mark staff as DEACTIVATED,
 * wipe password/token, and preserve historical completed jobs.
 */
export const deleteTechnician = async (req: Request, res: Response) => {
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

    return res.json({ success: true, message: 'Worker deactivated and active jobs unassigned' });
  } catch (error) {
    console.error('Error deleting technician:', error);
    return res.status(500).json({ error: 'Failed to delete worker' });
  }
};


