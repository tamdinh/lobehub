export type AdminRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type AdminToolScope = 'SYSTEM' | 'ORGANIZATION' | 'WORKSPACE';

export interface AdminToolMetadata {
  approvalRequired: boolean;
  description: string;
  idempotent: boolean;
  name: string;
  permission: string;
  riskLevel: AdminRiskLevel;
  scope: AdminToolScope;
}

export interface AdminUserSearchParams {
  limit?: number;
  query?: string;
  status?: 'active' | 'suspended';
}

export interface AdminUserSuspendParams {
  reason: string;
  userId: string;
}

export interface AdminWorkspaceFreezeParams {
  reason: string;
  workspaceId: string;
}

export interface AdminAgentRetryParams {
  reason: string;
  runId: string;
}

export interface AdminModelDisableParams {
  modelId: string;
  reason: string;
}

export interface AdminBillingRefundParams {
  idempotencyKey: string;
  reason: string;
  usageEventId: string;
}

export interface AdminAuditViewerParams {
  action?: string;
  actorId?: string;
  endDate?: Date;
  limit?: number;
  startDate?: Date;
  workspaceId?: string;
}
