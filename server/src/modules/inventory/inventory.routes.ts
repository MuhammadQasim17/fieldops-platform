import { Router } from 'express';
import {
  getInventory,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
} from './inventory.controller';

const router = Router();

// GET /api/inventory
router.get('/', getInventory);

// POST /api/inventory
router.post('/', createInventoryItem);

// PATCH /api/inventory/:id
router.patch('/:id', updateInventoryItem);

// DELETE /api/inventory/:id
router.delete('/:id', deleteInventoryItem);

export default router;

