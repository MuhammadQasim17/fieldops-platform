import { z } from 'zod';

export const createJobSchema = z.object({
  title: z
    .string()
    .min(3, 'Title must be at least 3 characters'),
  description: z
    .string()
    .min(5, 'Description must be at least 5 characters'),
  customerName: z
    .string()
    .min(2, 'Customer name must be at least 2 characters'),
  customerPhone: z
    .string()
    .min(5, 'Customer phone must be at least 5 characters'),
  customerAddress: z
    .string()
    .min(5, 'Customer address must be at least 5 characters'),
  customerEmail: z.string().email('Valid customer email is required').optional().nullable().or(z.literal('')),
  customer_email: z.string().email().optional().nullable().or(z.literal('')),
  email: z.string().email().optional().nullable().or(z.literal('')),
  priority: z
    .preprocess((val) => {
      if (typeof val === 'string') {
        const upper = val.toUpperCase();
        if (upper.includes('EMERGENCY')) return 'EMERGENCY';
        if (upper.includes('HIGH')) return 'HIGH';
        if (upper.includes('LOW')) return 'LOW';
        if (upper.includes('MEDIUM')) return 'MEDIUM';
      }
      return val;
    }, z.enum(['LOW', 'MEDIUM', 'HIGH', 'EMERGENCY']))
    .default('MEDIUM'),
  technicianId: z
    .string()
    .uuid('Technician ID must be a valid UUID')
    .optional()
    .nullable()
    .or(z.literal('')),
  assignedTechId: z.string().optional().nullable().or(z.literal('')),
  assignedStaffId: z.string().optional().nullable().or(z.literal('')),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
});

export const updateJobSchema = z.object({
  customerEmail: z.string().email().optional().nullable().or(z.literal('')),
  customer_email: z.string().email().optional().nullable().or(z.literal('')),
  email: z.string().email().optional().nullable().or(z.literal('')),
  status: z
    .enum(['PENDING', 'EN_ROUTE', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])
    .optional(),
  technicianId: z.string().optional().nullable(),
  assignedTechId: z.string().optional().nullable(),
  assignedStaffId: z.string().optional().nullable(),
  completionNotes: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  signatureData: z.string().optional().nullable(),
  signatureSvg: z.string().optional().nullable(),
  clientUpdatedAt: z.string().optional().nullable(),
  completedLatitude: z.number().optional().nullable(),
  completedLongitude: z.number().optional().nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  beforePhoto: z.string().optional().nullable(),
  beforePhotoUrl: z.string().optional().nullable(),
  afterPhoto: z.string().optional().nullable(),
  afterPhotoUrl: z.string().optional().nullable(),
  lastKnownLat: z.number().optional().nullable(),
  lastKnownLng: z.number().optional().nullable(),
  lastLocationUpdate: z.union([z.string(), z.number(), z.date()]).optional().nullable(),
  materialsUsed: z.union([z.string(), z.array(z.any())]).optional().nullable(),
  laborCost: z.number().optional().nullable(),
  customServices: z.union([z.string(), z.array(z.any())]).optional().nullable(),
  totalAmount: z.number().optional().nullable(),
  paymentStatus: z.string().optional().nullable(),
  paymentMethod: z.string().optional().nullable(),
  paymentNotes: z.string().optional().nullable(),
});

export const addJobMaterialsSchema = z.object({
  items: z.array(
    z.object({
      itemId: z.string(),
      quantity: z.number().min(1).default(1),
    })
  ).optional(),
  materials: z.array(
    z.object({
      itemId: z.string(),
      quantity: z.number().min(1).default(1),
    })
  ).optional(),
});

export const updateJobLocationSchema = z.object({
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  lat: z.number().optional().nullable(),
  lng: z.number().optional().nullable(),
  timestamp: z.union([z.number(), z.string()]).optional(),
});

export const createTechnicianSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Valid email address is required'),
  phone: z.string().optional().nullable(),
  password: z.string().min(4, 'Password must be at least 4 characters').optional().nullable().or(z.literal('')),
  role: z
    .enum(['TECHNICIAN', 'FIELD_ENGINEER', 'INSPECTOR', 'SUPERVISOR', 'DISPATCHER'])
    .default('TECHNICIAN')
    .optional(),
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type UpdateJobInput = z.infer<typeof updateJobSchema>;
export type CreateTechnicianInput = z.infer<typeof createTechnicianSchema>;
