import { PrismaClient } from '@prisma/client';

const rawDbUrl = process.env.DATABASE_URL;

if (!rawDbUrl) {
  console.warn(
    '[Prisma] Warning: DATABASE_URL environment variable is not defined. Ensure it is configured before executing database operations.'
  );
} else if (!rawDbUrl.startsWith('postgresql://') && !rawDbUrl.startsWith('postgres://')) {
  console.warn(
    `[Prisma] Warning: DATABASE_URL "${rawDbUrl}" does not start with postgresql:// or postgres://. In PostgreSQL mode, ensure a valid PostgreSQL connection string is configured.`
  );
}

const resolvedDbUrl =
  rawDbUrl && (rawDbUrl.startsWith('postgresql://') || rawDbUrl.startsWith('postgres://'))
    ? rawDbUrl
    : 'postgresql://postgres:postgres@localhost:5432/fieldops?schema=public';

// Ensure process.env.DATABASE_URL conforms to postgresql schema requirements
if (!process.env.DATABASE_URL || (!process.env.DATABASE_URL.startsWith('postgresql://') && !process.env.DATABASE_URL.startsWith('postgres://'))) {
  process.env.DATABASE_URL = resolvedDbUrl;
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    datasources: {
      db: {
        url: resolvedDbUrl,
      },
    },
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Technician model delegate mapping strictly for active field workers
if (!(prisma as any).technician) {
  (prisma as any).technician = {
    findFirst: (args: any) => {
      const where = args?.where || {};
      return (prisma.user as any).findFirst({
        ...args,
        where: {
          ...where,
          role: { not: 'DISPATCHER' },
        },
      });
    },
    findUnique: (args: any) => (prisma.user as any).findUnique(args),
    findMany: (args: any) => {
      const where = args?.where || {};
      return (prisma.user as any).findMany({
        ...args,
        where: {
          ...where,
          role: { not: 'DISPATCHER' },
        },
      });
    },
    create: (args: any) => (prisma.user as any).create(args),
    update: (args: any) => (prisma.user as any).update(args),
    delete: (args: any) => (prisma.user as any).delete(args),
    deleteMany: (args: any) => (prisma.user as any).deleteMany(args),
  };
}
