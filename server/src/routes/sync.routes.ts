import { Router } from 'express';
import { handleBatchSync } from '../controllers/sync.controller';

const router = Router();

// POST /api/sync - Atomic batch sync with Optimistic Concurrency Control & Server Delta Pull
router.post('/', handleBatchSync);

export default router;

