import { Router } from 'express';
import {
  getDispatcherMetrics,
  getTechnicians,
  createTechnician,
  deleteTechnician,
  getDispatcherSettings,
  updateDispatcherSettings,
} from '../controllers/dispatcher.controller';
import { createJob } from '../controllers/jobs.controller';
import { validate } from '../middleware/validate';
import { createJobSchema, createTechnicianSchema } from '../schemas/job.schema';

const router = Router();

// GET /api/dispatcher/metrics - Live aggregate operations stats
router.get('/metrics', getDispatcherMetrics);

// GET /api/dispatcher/technicians & /api/dispatcher/staff - All technicians with active workload count
router.get(['/technicians', '/staff'], getTechnicians);

// POST /api/dispatcher/technicians & /api/dispatcher/staff - Register new technician
router.post(['/technicians', '/staff'], validate(createTechnicianSchema), createTechnician);

// DELETE /api/dispatcher/technicians/:id & /api/dispatcher/staff/:id - Remove worker
router.delete('/technicians/:id', deleteTechnician);
router.delete('/staff/:id', deleteTechnician);

// POST /api/dispatcher/jobs - Create & assign new work order directly from dispatcher console
router.post('/jobs', validate(createJobSchema), createJob);

// Settings routes for boss defaults
router.get('/settings', getDispatcherSettings);
router.post('/settings', updateDispatcherSettings);
router.patch('/settings', updateDispatcherSettings);

export default router;

