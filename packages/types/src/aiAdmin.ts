import type { AdminRiskLevel } from './adminTools';

export type SpecialistAgentType =
  | 'OPERATIONS'
  | 'SUPPORT'
  | 'MODEL_OPS'
  | 'SECURITY'
  | 'BILLING';

export interface ActionRecommendation {
  action: string;
  agentType: SpecialistAgentType;
  confidence: number; // 0.0 to 1.0
  createdAt: Date;
  id: string;
  parameters: Record<string, unknown>;
  reasoning: string;
  riskLevel: AdminRiskLevel;
  targetResource: string;
}

export interface AgentDiagnosisReport {
  agentType: SpecialistAgentType;
  findings: string[];
  recommendations: ActionRecommendation[];
  status: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  summary: string;
}
