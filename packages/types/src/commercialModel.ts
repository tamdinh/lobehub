export type ModelCapability =
  | 'chat'
  | 'vision'
  | 'tool_call'
  | 'reasoning'
  | 'code'
  | 'json_mode'
  | 'embedding';

export type ModelTier = 'standard' | 'premium' | 'enterprise';

export interface ProviderCandidate {
  costPer1kInputTokensMicros: number;
  costPer1kOutputTokensMicros: number;
  enabled?: boolean;
  model: string;
  priority: number; // lower number = higher priority
  provider: string;
  weight?: number;
}

export interface CommercialModel {
  candidates: ProviderCandidate[];
  capabilities: ModelCapability[];
  contextWindow: number;
  description?: string;
  enabled: boolean;
  id: string;
  maxOutputTokens: number;
  name: string;
  tier: ModelTier;
}

export type TenantSubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'trialing';

export interface PlanEntitlements {
  backgroundAgents: boolean;
  maxAgents: number;
  maxWorkspaces: number;
  monthlyTokens: number;
  premiumModels: boolean | string[];
}

export interface TenantSubscription {
  currentPeriodEnd: Date;
  currentPeriodStart: Date;
  id: string;
  organizationId?: string;
  planId: string;
  status: TenantSubscriptionStatus;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  workspaceId: string;
}

export interface TenantQuotaCheckResult {
  allowed: boolean;
  current: number;
  limit: number;
  reason?: string;
}
