import { prisma } from '../prisma';

let tableInitialized = false;
let cachedBaseLaborFee: number = 50.0;

async function ensureTable() {
  if (tableInitialized) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS SystemSetting (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    tableInitialized = true;
  } catch (err) {
    console.warn('[SettingsService] Table ensure error:', err);
  }
}

export const settingsService = {
  async getSetting(key: string, defaultValue: string): Promise<string> {
    await ensureTable();
    try {
      const records: Array<{ key: string; value: string }> = await prisma.$queryRawUnsafe(
        'SELECT key, value FROM SystemSetting WHERE key = ? LIMIT 1',
        key
      );
      if (records && records.length > 0) {
        return records[0].value;
      }
      return defaultValue;
    } catch {
      return defaultValue;
    }
  },

  async setSetting(key: string, value: string): Promise<string> {
    await ensureTable();
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO SystemSetting (key, value, updatedAt) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = CURRENT_TIMESTAMP`,
        key,
        value
      );
      return value;
    } catch (err) {
      console.warn('[SettingsService] setSetting error:', err);
      return value;
    }
  },

  async getBaseLaborFee(): Promise<number> {
    const val = await this.getSetting('baseLaborFee', '50.0');
    const parsed = parseFloat(val);
    cachedBaseLaborFee = isNaN(parsed) ? 50.0 : parsed;
    return cachedBaseLaborFee;
  },

  async setBaseLaborFee(fee: number): Promise<number> {
    cachedBaseLaborFee = fee;
    await this.setSetting('baseLaborFee', fee.toString());
    return fee;
  },
};

