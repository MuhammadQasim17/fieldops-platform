export type JobPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'EMERGENCY';

export type JobStatus =
  | 'PENDING'
  | 'EN_ROUTE'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED';

export type UserRole =
  | 'DISPATCHER'
  | 'TECHNICIAN'
  | 'FIELD_ENGINEER'
  | 'INSPECTOR'
  | 'SUPERVISOR';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  phone?: string | null;
  status?: string | null;
  createdAt?: string;
  updatedAt?: string;
  activeJobsCount?: number;
}

export interface Technician {
  id?: string;
  name: string;
  phone?: string | null;
  role?: UserRole | string | null;
}

export interface Job {
  id: string;
  title: string;
  description: string;
  customerName: string;
  customerEmail?: string | null;
  customerPhone: string;
  customerAddress: string;
  latitude?: number | null;
  longitude?: number | null;
  priority: JobPriority;
  status: JobStatus;
  version?: number;
  clientUpdatedAt?: string | null;
  syncedAt?: string | null;
  is_synced?: boolean;
  pending_sync?: boolean;
  conflict?: boolean;
  conflictReason?: string | null;
  serverConflictState?: Partial<Job> | null;
  completionNotes?: string | null;
  signatureData?: string | null;
  signatureSvg?: string | null;
  completedAt?: string | null;
  completedLatitude?: number | null;
  completedLongitude?: number | null;
  beforePhoto?: string | null;
  beforePhotoUrl?: string | null;
  afterPhoto?: string | null;
  afterPhotoUrl?: string | null;
  lastKnownLat?: number | null;
  lastKnownLng?: number | null;
  lastLocationUpdate?: string | null;
  materialsUsed?: MaterialUsed[] | string | null;
  laborCost?: number;
  customServices?: CustomService[] | string | null;
  totalAmount?: number;
  paymentStatus?: string;
  paymentMethod?: string | null;
  paymentNotes?: string | null;
  technicianId?: string | null;
  technician?: Technician | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface CustomService {
  description: string;
  amount: number;
}

export interface InventoryItem {
  id: string;
  name: string;
  sku: string;
  unitCost: number;
  stockQty: number;
  quantityInStock?: number;
  category: string;
}

export interface MaterialUsed {
  itemId: string;
  name: string;
  sku: string;
  unitCost: number;
  quantity: number;
  totalCost: number;
  category?: string;
}

export type SyncMutationType = 'STATUS_UPDATE' | 'COMPLETE_JOB' | 'LOCATION_UPDATE';

export interface SyncMutation {
  jobId: string;
  type: SyncMutationType;
  clientVersion: number;
  clientUpdatedAt: string;
  data: Record<string, any>;
  idempotencyKey?: string;
}

export interface SyncProcessedItem {
  jobId: string;
  status: 'APPLIED';
  newVersion: number;
  syncedAt?: string;
  job?: Job;
}

export interface SyncConflictItem {
  jobId: string;
  status?: number;
  serverState: Job | null;
  reason: 'VERSION_MISMATCH' | 'NOT_FOUND' | string;
}

export interface SyncResponsePayload {
  success: boolean;
  processed: SyncProcessedItem[];
  conflicts: SyncConflictItem[];
  serverUpdates: Job[];
}

export interface QueuedAction {
  id: string;
  endpoint: string;
  method: string;
  body: any;
  timestamp: number;
  jobId?: string;
  clientVersion?: number;
  createdAt?: number;
  retryCount?: number;
  nextRetryTimestamp?: number;
  idempotencyKey?: string;
}

export type OfflineSyncQueueItem = QueuedAction;

export interface AuthResponse {
  token: string;
  user: User;
}

export type RootStackParamList = {
  Login: undefined;
  LoginScreen: undefined;
  Home: undefined;
  HomeScreen: undefined;
  JobList: undefined;
  JobDetail: { jobId: string };
  Signature: {
    jobId: string;
    customerName?: string;
    jobTitle?: string;
    beforePhoto?: string | null;
    beforePhotoUrl?: string | null;
    laborCost?: number;
  };
};
