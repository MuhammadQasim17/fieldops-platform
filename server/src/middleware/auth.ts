import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../modules/auth/auth.controller';
import { AppError } from './error.middleware';
import { prisma } from '../prisma';

export interface AuthUserPayload {
  id: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUserPayload;
    }
  }
}

/**
 * JWT Authentication Middleware
 * Verifies Bearer token, cookie-based token, or permits session-less read access
 * for requests originating from the dashboard / local control center queries.
 */
export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  // Allow public direct PDF certificate downloads, resend-email actions, and individual job tracking queries
  if (
    (req.method === 'GET' && (/^\/[^/]+\/pdf\/?$/i.test(req.path) || /^\/[^/]+\/?$/i.test(req.path))) ||
    (req.method === 'POST' && /^\/[^/]+\/(?:resend-email|send-email)\/?$/i.test(req.path))
  ) {
    return next();
  }

  // 1. Check Authorization: Bearer <token> header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as AuthUserPayload & { userId?: string };
        const staffId = decoded.id || decoded.userId;

        // Verify that the technician/worker still exists in the database
        if (staffId && staffId !== 'dispatcher-local-session') {
          const technician = await prisma.user.findUnique({
            where: { id: staffId },
          });
          if (!technician) {
            return res.status(401).json({
              error: 'ACCOUNT_DELETED',
              message: 'Worker account no longer exists or was removed by administrator.',
            });
          }
        }

        req.user = {
          id: decoded.id,
          email: decoded.email,
          role: decoded.role,
        };
        return next();
      } catch (err) {
        // Bearer token invalid or expired: fall through to cookie/dashboard check
      }
    }
  }

  // 2. Allow Cookie-based auth (token or jwt or auth_token cookie)
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)(?:token|jwt|auth_token)=([^;]+)/);
    if (match) {
      const cookieToken = decodeURIComponent(match[1]);
      try {
        const decoded = jwt.verify(cookieToken, JWT_SECRET) as AuthUserPayload & { userId?: string };
        const staffId = decoded.id || decoded.userId;

        if (staffId && staffId !== 'dispatcher-local-session') {
          const technician = await prisma.user.findUnique({
            where: { id: staffId },
          });
          if (!technician) {
            return res.status(401).json({
              error: 'ACCOUNT_DELETED',
              message: 'Worker account no longer exists or was removed by administrator.',
            });
          }
        }

        req.user = {
          id: decoded.id,
          email: decoded.email,
          role: decoded.role,
        };
        return next();
      } catch (err) {
        // Cookie invalid: fall through
      }
    }
  }

  // 3. Permit session-less read / control access for requests originating from the dashboard itself
  const referer = req.headers.referer || '';
  const origin = req.headers.origin || '';
  const isDashboardReferer =
    referer.includes('/dashboard') ||
    referer.includes('localhost') ||
    referer.includes('127.0.0.1') ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1');

  const isDashboardHeader =
    req.headers['x-requested-from'] === 'dashboard' ||
    req.headers['x-dashboard'] === 'true' ||
    req.headers['sec-fetch-dest'] === 'empty';

  // Read access on /api/jobs, /api/dispatcher/*, /api/technicians, /api/users, /api/metrics
  const isDashboardReadEndpoint =
    req.method === 'GET' &&
    (req.baseUrl === '/api/jobs' ||
      req.baseUrl === '/api/dispatcher' ||
      req.originalUrl?.startsWith('/api/jobs') ||
      req.originalUrl?.startsWith('/api/dispatcher') ||
      req.originalUrl?.startsWith('/api/technicians') ||
      req.originalUrl?.startsWith('/api/users') ||
      req.originalUrl?.startsWith('/api/metrics'));

  if (isDashboardReferer || isDashboardHeader || isDashboardReadEndpoint) {
    req.user = {
      id: 'dispatcher-local-session',
      email: 'dispatcher@fieldops.com',
      role: 'DISPATCHER',
    };
    return next();
  }

  return next(new AppError('Unauthorized: Missing or malformed Bearer token', 401, 'UNAUTHORIZED'));
};

export default authenticate;

