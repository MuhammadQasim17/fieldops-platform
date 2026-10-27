import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { JsonWebTokenError, TokenExpiredError, NotBeforeError } from 'jsonwebtoken';

/**
 * Custom application operational error class.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly isOperational: boolean;
  public readonly details: any;

  constructor(
    message: string,
    statusCode: number = 500,
    errorCode: string = 'INTERNAL_SERVER_ERROR',
    isOperational: boolean = true,
    details: any = null
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = isOperational;
    this.details = details;

    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export interface ErrorResponseBody {
  success: false;
  error: {
    code: string;
    message: string;
    details: any;
  };
}

/**
 * Global Express centralized error handling middleware.
 * Formats errors into a uniform JSON response:
 * { "success": false, "error": { "code": string, "message": string, "details": any } }
 */
export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // If headers were already committed, delegate to default Express handler
  if (res.headersSent) {
    return next(err);
  }

  let statusCode = 500;
  let errorCode = 'INTERNAL_SERVER_ERROR';
  let message = 'An unexpected internal error occurred.';
  let details: any = null;

  // 1. Custom AppError
  if (err instanceof AppError) {
    statusCode = err.statusCode;
    errorCode = err.errorCode;
    message = err.message;
    details = err.details;
  }
  // 2. Zod Validation Error
  else if (err instanceof ZodError) {
    statusCode = 400;
    errorCode = 'VALIDATION_FAILED';
    message = 'Validation failed for request data.';
    details = err.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
  }
  // 3. Prisma Database Errors
  else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      statusCode = 409;
      errorCode = 'CONFLICT_UNIQUE_CONSTRAINT';
      const target = err.meta?.target;
      message = `Unique constraint violation on field(s): ${Array.isArray(target) ? target.join(', ') : target || 'unknown'}.`;
      details = { fields: target, prismaCode: err.code };
    } else if (err.code === 'P2025') {
      statusCode = 404;
      errorCode = 'NOT_FOUND';
      message = (err.meta?.cause as string) || 'Requested database record was not found.';
      details = { prismaCode: err.code };
    } else if (err.code === 'P2003') {
      statusCode = 400;
      errorCode = 'FOREIGN_KEY_VIOLATION';
      message = 'Foreign key constraint failed on relationship.';
      details = { field: err.meta?.field_name, prismaCode: err.code };
    } else {
      statusCode = 400;
      errorCode = 'DATABASE_REQUEST_ERROR';
      message = err.message || 'Database operation error.';
      details = { prismaCode: err.code };
    }
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    statusCode = 400;
    errorCode = 'DATABASE_VALIDATION_ERROR';
    message = 'Invalid parameters passed to database query.';
    details = process.env.NODE_ENV === 'development' ? err.message : null;
  }
  // 4. JWT Authentication Errors
  else if (err instanceof TokenExpiredError) {
    statusCode = 401;
    errorCode = 'TOKEN_EXPIRED';
    message = 'Authentication token has expired.';
    details = { expiredAt: err.expiredAt };
  } else if (err instanceof NotBeforeError) {
    statusCode = 401;
    errorCode = 'TOKEN_NOT_ACTIVE';
    message = 'Authentication token is not active yet.';
    details = { date: err.date };
  } else if (err instanceof JsonWebTokenError) {
    statusCode = 401;
    errorCode = 'UNAUTHORIZED';
    message = err.message || 'Invalid authentication token.';
    details = null;
  }
  // 5. Generic Unhandled Errors
  else {
    statusCode =
      typeof err.statusCode === 'number'
        ? err.statusCode
        : typeof err.status === 'number'
        ? err.status
        : 500;
    errorCode = err.errorCode || err.code || 'INTERNAL_SERVER_ERROR';
    message = err.message || 'An unexpected internal error occurred.';
    details = process.env.NODE_ENV === 'development' ? err.stack : null;
  }

  // Telemetry Logging
  const route = req.originalUrl || req.url;
  if (statusCode >= 500) {
    console.error(`[ErrorTelemetry] 💥 5xx Error [${errorCode}] on ${req.method} ${route}:`, {
      message: err?.message,
      stack: err?.stack,
    });
  } else {
    console.warn(`[ErrorTelemetry] ⚠️ ${statusCode} [${errorCode}] on ${req.method} ${route}: ${message}`);
  }

  const responseBody: ErrorResponseBody = {
    success: false,
    error: {
      code: errorCode,
      message,
      details,
    },
  };

  return res.status(statusCode).json(responseBody);
};

export default errorHandler;

