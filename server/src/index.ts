import 'dotenv/config';

process.on('uncaughtException', (err) => {
  console.error('[Process Uncaught Exception]:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process Unhandled Rejection]:', reason);
});

// Validate required environment variables at boot
if (!process.env.JWT_SECRET || !process.env.DATABASE_URL) {
  console.error('[FATAL] Missing required environment variables: JWT_SECRET and DATABASE_URL must be defined.');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'fieldops_local_dev_secret_key') {
    console.error('FATAL: A secure JWT_SECRET must be set in production!');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL is missing in production!');
    process.exit(1);
  }
}

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import jobsRouter from './routes/jobs.routes';
import dispatcherRouter from './routes/dispatcher.routes';
import syncRouter from './routes/sync.routes';
import authRouter from './modules/auth/auth.routes';
import publicRouter from './routes/public.routes';
import inventoryRouter from './modules/inventory/inventory.routes';
import { eventsHandler } from './modules/events/events.service';
import { getTechnicians, createTechnician, deleteTechnician, getDispatcherSettings, updateDispatcherSettings } from './controllers/dispatcher.controller';
import { validate } from './middleware/validate';
import { authenticate } from './middleware/auth';
import { createTechnicianSchema } from './schemas/job.schema';
import { inventoryService } from './modules/inventory/inventory.service';
import { prisma } from './prisma';
import { getTransporter, verifyTransporter, getSmtpConfig } from './modules/notifications/email.service';
import { errorHandler } from './middleware/error.middleware';

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 5000;

const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['*'];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Blocked by CORS policy'));
      }
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
  })
);

// Strict authentication rate limiter for login attempts
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // max 15 attempts per IP
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', authLimiter);

// General API rate limiter across all /api/ endpoints
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Request Telemetry Middleware: Log method, route, status code, and execution duration
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const route = req.originalUrl || req.url;
    console.log(`[API] ${req.method} ${route} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'FieldOps API' });
});

// Authentication Routes
app.use('/api/auth', authRouter);

// Public Customer Service Request Intake (Unprotected)
app.use('/api/public', publicRouter);

// Real-Time Server-Sent Events (SSE) Telemetry Stream
app.get(['/api/events', '/api/dispatcher/events'], eventsHandler);

// Primary API Routes (Protected by JWT Authentication Middleware)
app.use('/api/jobs', authenticate, jobsRouter);
app.use('/api/sync', authenticate, syncRouter);
app.use('/api/dispatcher', authenticate, dispatcherRouter);
app.use('/api/inventory', inventoryRouter);
app.get(['/api/technicians', '/api/staff', '/api/users'], authenticate, getTechnicians);
app.post(['/api/technicians', '/api/staff', '/api/users'], authenticate, validate(createTechnicianSchema), createTechnician);
app.delete(['/api/technicians/:id', '/api/staff/:id', '/api/users/:id'], authenticate, deleteTechnician);
app.get('/api/settings', authenticate, getDispatcherSettings);
app.post('/api/settings', authenticate, updateDispatcherSettings);
app.patch('/api/settings', authenticate, updateDispatcherSettings);

// Serve Web Dispatcher Dashboard UI & Customer Booking Intake statically
const dashboardPath = path.join(__dirname, '../public/dashboard');
const webPath = path.join(__dirname, '../../web');

// Establish dashboardPath as authoritative runtime web bundle, falling back to webPath
const staticDir = fs.existsSync(path.join(dashboardPath, 'index.html')) ? dashboardPath : webPath;

app.use('/dashboard', express.static(staticDir));
app.use('/dashboard', express.static(webPath));
app.use(express.static(staticDir));
app.use(express.static(webPath));

app.get(['/request', '/request.html'], (req, res) => {
  const requestFile = fs.existsSync(path.join(dashboardPath, 'request.html'))
    ? path.join(dashboardPath, 'request.html')
    : path.join(webPath, 'request.html');
  res.sendFile(requestFile);
});

app.get(['/', '/dashboard', '/dashboard/index.html'], (req, res) => {
  const indexFile = fs.existsSync(path.join(dashboardPath, 'index.html'))
    ? path.join(dashboardPath, 'index.html')
    : path.join(webPath, 'index.html');
  res.sendFile(indexFile);
});

// Centralized Global Error Handling Middleware (mounted as the very last middleware)
app.use(errorHandler);

// Seed default inventory on boot
inventoryService.seedDefaultPartsIfEmpty().catch((err) => {
  console.warn('[Server] Inventory seed error:', err);
});

// Verify SMTP transport connectivity once on server startup
getTransporter()
  .then((transporter) => {
    const smtp = getSmtpConfig();
    if (smtp) {
      verifyTransporter(transporter, `${smtp.host}:${smtp.port} (${smtp.user})`);
    }
  })
  .catch((err) => {
    console.warn('[Server] SMTP startup verification error:', err);
  });

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
    console.log(`Web Dispatcher Dashboard available at http://localhost:${PORT}/dashboard`);
  });
}

export default app;