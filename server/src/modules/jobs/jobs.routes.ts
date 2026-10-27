import { Router } from 'express';
import {
  getJobs,
  getJobById,
  updateJob,
  createJob,
  getJobPdf,
  updateJobLocation,
  addJobMaterials,
  removeJobMaterial,
  resendJobEmail,
} from '../../controllers/jobs.controller';
import { validate } from '../../middleware/validate';
import { createJobSchema, updateJobSchema, updateJobLocationSchema } from '../../schemas/job.schema';

const router = Router();

// GET /api/jobs
router.get('/', getJobs);

// POST /api/jobs - Create & assign new work order
router.post('/', validate(createJobSchema), createJob);

// GET /api/jobs/:id/pdf - Stream or download PDF certificate
router.get('/:id/pdf', getJobPdf);

// POST /api/jobs/:id/resend-email & /send-email - Dispatch customer completion email with PDF
router.post('/:id/resend-email', resendJobEmail);
router.post('/:id/send-email', resendJobEmail);

// POST /api/jobs/:id/materials - Add parts/materials used to a job
router.post('/:id/materials', addJobMaterials);

// DELETE /api/jobs/:id/materials/:itemId - Remove part and increment inventory stock
router.delete('/:id/materials/:itemId', removeJobMaterial);

// PATCH /api/jobs/:id/location - Live technician GPS location ingestion
router.patch('/:id/location', validate(updateJobLocationSchema), updateJobLocation);

// GET /api/jobs/:id
router.get('/:id', getJobById);

// PATCH /api/jobs/:id/status
router.patch('/:id/status', validate(updateJobSchema), updateJob);

// PATCH & POST /api/jobs/:id/complete
router.patch('/:id/complete', validate(updateJobSchema), updateJob);
router.post('/:id/complete', validate(updateJobSchema), updateJob);

// PATCH /api/jobs/:id
router.patch('/:id', validate(updateJobSchema), updateJob);

export default router;

