import { prisma } from '../../prisma';

export interface InventoryItemDto {
  id: string;
  name: string;
  sku: string;
  unitCost: number;
  stockQty: number;
  quantityInStock: number;
  category?: string;
}

export interface MaterialUsageRequestItem {
  itemId: string;
  quantity: number;
}

export interface MaterialUsedRecord {
  itemId: string;
  name: string;
  sku: string;
  unitCost: number;
  quantity: number;
  totalCost: number;
  category?: string;
}

const DEFAULT_PARTS = [
  {
    name: 'Dual Run Capacitor 45/5 uF',
    sku: 'CAP-455-UF',
    unitCost: 18.0,
    quantityInStock: 14,
  },
  {
    name: 'Compressor Relay 2-Pole 30A',
    sku: 'REL-2P-30A',
    unitCost: 24.0,
    quantityInStock: 8,
  },
  {
    name: '12V 9Ah Sealed Backup Battery',
    sku: 'BAT-12V-9AH',
    unitCost: 32.5,
    quantityInStock: 12,
  },
  {
    name: 'Fiber Optic Patch Cable SC-LC',
    sku: 'FIB-SCLC-10M',
    unitCost: 15.0,
    quantityInStock: 20,
  },
];

class InventoryService {
  private seeded = false;

  /**
   * Ensure default truck inventory parts exist in Prisma table on startup
   */
  public async seedDefaultPartsIfEmpty(): Promise<void> {
    if (this.seeded) return;
    try {
      const count = await prisma.inventoryItem.count();
      if (count === 0) {
        for (const part of DEFAULT_PARTS) {
          await prisma.inventoryItem.create({
            data: part,
          });
        }
        console.log('[InventoryService] Seeded 4 default repair parts into Prisma InventoryItem table');
      }
      this.seeded = true;
    } catch (err) {
      console.warn('[InventoryService] Seed check warning:', err);
    }
  }

  /**
   * Fetch all inventory items from Prisma
   */
  public async getAll(): Promise<InventoryItemDto[]> {
    await this.seedDefaultPartsIfEmpty();
    const items = await prisma.inventoryItem.findMany({
      orderBy: { name: 'asc' },
    });

    return items.map((i) => ({
      id: i.id,
      name: i.name,
      sku: i.sku,
      unitCost: i.unitCost,
      quantityInStock: i.quantityInStock,
      stockQty: i.quantityInStock,
      category: 'Truck Stock',
    }));
  }

  /**
   * Fetch single inventory item by ID
   */
  public async getById(id: string): Promise<InventoryItemDto | null> {
    await this.seedDefaultPartsIfEmpty();
    const item = await prisma.inventoryItem.findUnique({
      where: { id },
    });

    if (!item) return null;

    return {
      id: item.id,
      name: item.name,
      sku: item.sku,
      unitCost: item.unitCost,
      quantityInStock: item.quantityInStock,
      stockQty: item.quantityInStock,
      category: 'Truck Stock',
    };
  }

  /**
   * Deduct used materials from Prisma persistent inventory
   */
  public async deductMaterials(
    items: Array<{ itemId: string; quantity: number }>
  ): Promise<MaterialUsedRecord[]> {
    await this.seedDefaultPartsIfEmpty();
    const results: MaterialUsedRecord[] = [];

    for (const reqItem of items) {
      const qty = Math.max(1, Number(reqItem.quantity) || 1);

      // Search by ID or SKU
      const inventoryItem = await prisma.inventoryItem.findFirst({
        where: {
          OR: [{ id: reqItem.itemId }, { sku: reqItem.itemId }],
        },
      });

      if (inventoryItem) {
        const updated = await prisma.inventoryItem.update({
          where: { id: inventoryItem.id },
          data: {
            quantityInStock: { decrement: qty },
          },
        });

        // Ensure stock doesn't become negative
        if (updated.quantityInStock < 0) {
          await prisma.inventoryItem.update({
            where: { id: inventoryItem.id },
            data: { quantityInStock: 0 },
          });
        }

        results.push({
          itemId: inventoryItem.id,
          name: inventoryItem.name,
          sku: inventoryItem.sku,
          unitCost: inventoryItem.unitCost,
          quantity: qty,
          totalCost: Number((inventoryItem.unitCost * qty).toFixed(2)),
          category: 'Truck Stock',
        });
      } else {
        // Fallback for custom or direct items
        results.push({
          itemId: reqItem.itemId,
          name: (reqItem as any).name || 'Replacement Part',
          sku: (reqItem as any).sku || 'GEN-PART',
          unitCost: Number((reqItem as any).unitCost) || 0,
          quantity: qty,
          totalCost: Number((((reqItem as any).unitCost || 0) * qty).toFixed(2)),
          category: (reqItem as any).category || 'General Parts',
        });
      }
    }

    return results;
  }

  /**
   * Restore materials to Prisma persistent inventory (increment stock atomically)
   */
  public async restoreMaterials(
    items: Array<{ itemId: string; quantity: number }>
  ): Promise<void> {
    await this.seedDefaultPartsIfEmpty();
    for (const reqItem of items) {
      const qty = Math.max(1, Number(reqItem.quantity) || 1);
      const inventoryItem = await prisma.inventoryItem.findFirst({
        where: {
          OR: [{ id: reqItem.itemId }, { sku: reqItem.itemId }],
        },
      });

      if (inventoryItem) {
        await prisma.inventoryItem.update({
          where: { id: inventoryItem.id },
          data: {
            quantityInStock: { increment: qty },
          },
        });
      }
    }
  }

  /**
   * Add a new inventory item
   */
  public async createItem(data: {
    name: string;
    sku: string;
    unitCost: number;
    quantityInStock?: number;
  }): Promise<InventoryItemDto> {
    await this.seedDefaultPartsIfEmpty();
    const item = await prisma.inventoryItem.create({
      data: {
        name: data.name,
        sku: (data.sku || `PART-${Date.now()}`).trim().toUpperCase(),
        unitCost: Number(data.unitCost) || 0,
        quantityInStock: Math.max(0, Number(data.quantityInStock) || 0),
      },
    });

    return {
      id: item.id,
      name: item.name,
      sku: item.sku,
      unitCost: item.unitCost,
      quantityInStock: item.quantityInStock,
      stockQty: item.quantityInStock,
      category: 'Truck Stock',
    };
  }

  /**
   * Update an existing inventory item's price or stock quantity
   */
  public async updateItem(
    id: string,
    data: {
      name?: string;
      sku?: string;
      unitCost?: number;
      quantityInStock?: number;
    }
  ): Promise<InventoryItemDto | null> {
    await this.seedDefaultPartsIfEmpty();
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.sku !== undefined) updateData.sku = data.sku.trim().toUpperCase();
    if (data.unitCost !== undefined) updateData.unitCost = Number(data.unitCost);
    if (data.quantityInStock !== undefined) updateData.quantityInStock = Math.max(0, Number(data.quantityInStock));

    const item = await prisma.inventoryItem.update({
      where: { id },
      data: updateData,
    });

    return {
      id: item.id,
      name: item.name,
      sku: item.sku,
      unitCost: item.unitCost,
      quantityInStock: item.quantityInStock,
      stockQty: item.quantityInStock,
      category: 'Truck Stock',
    };
  }

  /**
   * Delete an inventory item
   */
  public async deleteItem(id: string): Promise<boolean> {
    await this.seedDefaultPartsIfEmpty();
    await prisma.inventoryItem.delete({
      where: { id },
    });
    return true;
  }
}

export const inventoryService = new InventoryService();
// Initialize seed check asynchronously
inventoryService.seedDefaultPartsIfEmpty().catch(() => {});
