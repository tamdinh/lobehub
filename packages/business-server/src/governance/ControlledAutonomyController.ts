import type {
  ActionRecommendation,
  ActorContext,
  RiskFactors,
} from '@lobechat/types';
import { randomUUID } from 'node:crypto';

import type { AuditService } from '../audit/AuditService';
import type { ModelCatalogService } from '../catalog/ModelCatalogService';
import type { ApprovalEngine } from './ApprovalEngine';
import type { RiskEngine } from './RiskEngine';

export interface AutonomyExecutionResult {
  approvalId?: string;
  executed: boolean;
  reason?: string;
  remediationId?: string;
  status: 'AUTO_REMEDIATED' | 'ESCALATED_FOR_APPROVAL' | 'BLOCKED_LOOP_LIMIT';
}

export class ControlledAutonomyController {
  private riskEngine: RiskEngine;
  private approvalEngine: ApprovalEngine;
  private auditService?: AuditService;
  private catalog?: ModelCatalogService;

  // In-memory loop counter: targetResource -> retry count
  private executionCounts: Map<string, number> = new Map();
  private maxAutoRemediations = 3;

  constructor(
    riskEngine: RiskEngine,
    approvalEngine: ApprovalEngine,
    auditService?: AuditService,
    catalog?: ModelCatalogService,
  ) {
    this.riskEngine = riskEngine;
    this.approvalEngine = approvalEngine;
    this.auditService = auditService;
    this.catalog = catalog;
  }

  /**
   * Evaluates a specialist agent's recommendation and decides between:
   * 1. Autonomous remediation (if risk <= MEDIUM, reversible, and within loop limits).
   * 2. Human escalation (if HIGH/CRITICAL risk or irreversible).
   */
  processRecommendation = async (
    recommendation: ActionRecommendation,
    actor: ActorContext,
    workspaceId: string,
  ): Promise<AutonomyExecutionResult> => {
    // 1. Build contextual risk factors
    const factors: RiskFactors = {
      action: recommendation.action,
      actor,
      blastRadius:
        recommendation.riskLevel === 'CRITICAL'
          ? 'GLOBAL'
          : recommendation.riskLevel === 'HIGH'
            ? 'WORKSPACE'
            : 'SINGLE_RESOURCE',
      confidence: recommendation.confidence,
      dataSensitivity: recommendation.riskLevel === 'HIGH' ? 'CONFIDENTIAL' : 'INTERNAL',
      environment: 'PRODUCTION',
      financialImpactMicros: 0,
      reversibility:
        recommendation.action === 'admin.agent.retry'
          ? 'REVERSIBLE'
          : recommendation.action === 'admin.model.disable'
            ? 'REVERSIBLE'
            : 'PARTIALLY_REVERSIBLE',
      scope: 'WORKSPACE',
      target: recommendation.targetResource,
    };

    const riskAssessment = this.riskEngine.evaluateRisk(factors);

    // 2. High or Critical Risk -> Escalate unconditionally to ApprovalEngine
    if (riskAssessment.requiresApproval) {
      const approvalRequest = this.approvalEngine.createApprovalRequest({
        action: recommendation.action,
        parameters: recommendation.parameters,
        riskAssessment,
        target: recommendation.targetResource,
      });

      if (this.auditService) {
        await this.auditService.recordAuditEvent({
          action: 'autonomy.escalated_to_approval',
          actor,
          metadata: {
            approvalId: approvalRequest.id,
            recommendationId: recommendation.id,
            riskScore: riskAssessment.score,
          },
          requestId: `req_autonomy_esc_${Date.now()}`,
          resourceId: recommendation.targetResource,
          result: 'SUCCESS',
          workspaceId,
        });
      }

      return {
        approvalId: approvalRequest.id,
        executed: false,
        reason: `Risk score (${riskAssessment.score}) requires human dual-control approval.`,
        status: 'ESCALATED_FOR_APPROVAL',
      };
    }

    // 3. Autonomous Remediation Path: Check loop limits
    const currentCount = this.executionCounts.get(recommendation.targetResource) || 0;
    if (currentCount >= this.maxAutoRemediations) {
      if (this.auditService) {
        await this.auditService.recordAuditEvent({
          action: 'autonomy.loop_limit_exceeded',
          actor,
          metadata: { attempts: currentCount, target: recommendation.targetResource },
          requestId: `req_loop_limit_${Date.now()}`,
          resourceId: recommendation.targetResource,
          result: 'DENIED',
          workspaceId,
        });
      }

      return {
        executed: false,
        reason: `Max automated remediation attempts (${this.maxAutoRemediations}) reached for '${recommendation.targetResource}'. Human intervention required.`,
        status: 'BLOCKED_LOOP_LIMIT',
      };
    }

    // 4. Increment loop count
    this.executionCounts.set(recommendation.targetResource, currentCount + 1);

    // 5. Execute autonomous action
    const remediationId = `rem_${randomUUID().replace(/-/g, '')}`;

    if (recommendation.action === 'admin.model.disable' && this.catalog) {
      const modelId = recommendation.parameters.modelId as string;
      const model = this.catalog.getModel(modelId);
      if (model) {
        model.enabled = false;
      }
    }

    // 6. Record immutable audit trail
    if (this.auditService) {
      await this.auditService.recordAuditEvent({
        action: `autonomy.remediated.${recommendation.action}`,
        actor,
        metadata: {
          confidence: recommendation.confidence,
          parameters: recommendation.parameters,
          recommendationId: recommendation.id,
          remediationId,
        },
        requestId: `req_auto_rem_${Date.now()}`,
        resourceId: recommendation.targetResource,
        result: 'SUCCESS',
        workspaceId,
      });
    }

    return {
      executed: true,
      remediationId,
      status: 'AUTO_REMEDIATED',
    };
  };

  getExecutionCount = (targetResource: string): number => {
    return this.executionCounts.get(targetResource) || 0;
  };
}
