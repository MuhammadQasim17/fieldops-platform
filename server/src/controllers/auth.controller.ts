import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma';

export const JWT_SECRET = process.env.JWT_SECRET as string;
const JWT_EXPIRES_IN = '7d';

/**
 * POST /api/auth/login
 * Strict database authentication for technicians.
 * Enforces worker deletion check: returns 403 NOT_A_MEMBER if technician does not exist in Prisma.
 */
export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body || {};
    const cleanEmail = (email || '').trim().toLowerCase();

    if (!cleanEmail || !password || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    // 1. Check user record
    const technician = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanEmail },
          { phone: cleanEmail },
        ],
      },
    });

    // 2. Strictly reject if technician record does not exist or account is deactivated
    if (!technician || technician.role === 'DEACTIVATED') {
      return res.status(403).json({
        success: false,
        error: 'NOT_A_MEMBER',
        message: 'You are not a member of this company. Contact your supervisor to be added to the team directory.',
      });
    }

    // 3. Verify password
    let isPasswordValid = false;

    if (
      technician.password.startsWith('$2a$') ||
      technician.password.startsWith('$2b$') ||
      technician.password.startsWith('$2y$')
    ) {
      isPasswordValid = await bcrypt.compare(password, technician.password);
    } else {
      // Legacy unhashed password migration support: compare and upgrade to bcrypt hash in DB
      if (password === technician.password) {
        isPasswordValid = true;
        const upgradedHash = await bcrypt.hash(password, 10);
        await prisma.user.update({
          where: { id: technician.id },
          data: { password: upgradedHash },
        });
      }
    }

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    const token = jwt.sign(
      {
        id: technician.id,
        email: technician.email,
        role: technician.role,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    return res.json({
      success: true,
      token,
      user: {
        id: technician.id,
        name: technician.name,
        email: technician.email,
        role: technician.role,
        phone: technician.phone,
      },
    });
  } catch (error) {
    console.error('[AuthController] Login error:', error);
    return res.status(500).json({ success: false, error: 'Authentication failed' });
  }
};
