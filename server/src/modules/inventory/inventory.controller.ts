import { Request, Response } from 'express';
import { inventoryService } from './inventory.service';

export const getInventory = async (req: Request, res: Response) => {
  try {
    const items = await inventoryService.getAll();
    res.json(items);
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
};

export const createInventoryItem = async (req: Request, res: Response) => {
  try {
    const { name, sku, unitCost, quantityInStock } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Item name is required' });
    }
    const item = await inventoryService.createItem({
      name: name.trim(),
      sku: sku || `PART-${Date.now()}`,
      unitCost: Number(unitCost) || 0,
      quantityInStock: Number(quantityInStock) || 0,
    });
    res.status(201).json(item);
  } catch (error: any) {
    console.error('Error creating inventory item:', error);
    res.status(500).json({ error: error?.message || 'Failed to create inventory item' });
  }
};

export const updateInventoryItem = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name, sku, unitCost, quantityInStock } = req.body;
    const item = await inventoryService.updateItem(id, {
      name,
      sku,
      unitCost: unitCost !== undefined ? Number(unitCost) : undefined,
      quantityInStock: quantityInStock !== undefined ? Number(quantityInStock) : undefined,
    });
    if (!item) {
      return res.status(404).json({ error: 'Inventory item not found' });
    }
    res.json(item);
  } catch (error: any) {
    console.error('Error updating inventory item:', error);
    res.status(500).json({ error: error?.message || 'Failed to update inventory item' });
  }
};

export const deleteInventoryItem = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    await inventoryService.deleteItem(id);
    res.json({ success: true, message: 'Item deleted' });
  } catch (error: any) {
    console.error('Error deleting inventory item:', error);
    res.status(500).json({ error: error?.message || 'Failed to delete inventory item' });
  }
};
