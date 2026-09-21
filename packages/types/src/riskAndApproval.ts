import type { AdminRiskLevel } from './adminTools';
import type { ActorContext } from './saasSecurity';

export interface RiskFactors {
  action: string;
  actor: ActorContext;
  blastRadius: 'SINGLE_RESOURCE' | 'WORKSPACE' | 'CROSS_TENANT' | 'GLOBAL';
  confidence: number; // 0.0 to 1.0
  dataSensitivity: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
  environment: 'PRODUCTION' | 'STAGING' | 'DEVELOPMENT';
  financialImpactMicros: number;
  reversibility: 'REVERSIBLE' | 'PARTIALLY_REVERSIBLE' | 'IRREVERSIBLE';
  scope: 'WORKSPACE' | 'SYSTEM';
  target: string;
}

export interface RiskAssessment {
  evaluatedAt: Date;
  factors: RiskFactors;
  reasoning: string[];
  requiresApproval: boolean;
  riskLevel: AdminRiskLevel;
  score: number; // 0 - 100
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface ApprovalRequest {
  action: string;
  approvedAt?: Date;
  approvedBy?: string;
  createdAt: Date;
  expiresAt: Date;
  id: string;
  parametersHash: string;
  rejectionReason?: string;
  riskAssessment: RiskAssessment;
  status: ApprovalStatus;
  target: string;
}
