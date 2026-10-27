# FieldOps Platform Architecture & Specification

## Architecture Overview
- **Client**: React Native (Expo SDK 54+) with TypeScript, React Navigation, React Native Safe Area Context, and Expo Vector Icons.
- **Server**: Node.js, Express, TypeScript, and Prisma ORM.
- **Database**: SQLite (via Prisma) for zero-latency local development with schema parity for PostgreSQL.
- **Local Network Endpoint**: `http://192.168.1.7:5000/api`

## Directory Conventions
- `client/src/screens/`: Independent views (e.g., JobListScreen, JobDetailScreen, SignatureScreen).
- `client/src/components/`: Reusable UI elements (badges, buttons, cards).
- `client/src/services/`: Network calls, offline cache, and API clients.
- `client/src/types/`: TypeScript interfaces for Job, User, and API responses.
- `server/src/routes/`: Express route definitions.
- `server/src/controllers/`: Business logic handlers.
- `server/prisma/`: Schema definitions and migration artifacts.

## Current Schema Models
- `User`: Technicians and Dispatchers (Authentication, Contact).
- `Job`: Work orders with status lifecycle (`PENDING` -> `EN_ROUTE` -> `IN_PROGRESS` -> `COMPLETED`), priorities, customer metadata, and signature storage.

## Dispatcher REST Endpoints
- `POST /api/jobs`: Create and assign a work order (validated via Zod).
- `GET /api/jobs`: Retrieve all jobs with optional query filtering (`status`, `priority`, `technicianId`).
- `GET /api/jobs/:id`: Retrieve single job details.
- `PATCH /api/jobs/:id`: Update job lifecycle, completion notes, signature Data URI, and sync timestamps.
- `GET /api/dispatcher/metrics`: Live operations aggregate stats (active dispatches, pending orders, completed today, urgent alerts, priority & status breakdowns).
- `GET /api/technicians`: Active fleet technicians with active workload count.

## Web Dispatcher Dashboard
- Location: `web/index.html` (hosted on Express at `/dashboard` and `/`).
- Executive Metrics Bar: Real-time KPI cards for Active Dispatches, Pending Orders, Completed Today, and Urgent Alerts.
- Live Dispatch Table: Status & Priority filtering, live search, and technician assignments.
- Quick Dispatch Modal: Direct work order creation and assignment to field technicians.
- Job Completion Audit Drawer: Slide-over drawer with technician notes and customer digital signature preview.