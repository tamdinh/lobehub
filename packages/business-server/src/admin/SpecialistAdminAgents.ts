import type {
  ActionRecommendation,
  AgentDiagnosisReport,
  SpecialistAgentType,
} from '@lobechat/types';
import { randomUUID } from 'node:crypto';

import type { ModelCatalogService } from '../catalog/ModelCatalogService';

function makeRecommendation(params: Omit<ActionRecommendation, 'id' | 'createdAt'>): ActionRecommendation {
  return {
    ...params,
    createdAt: new Date(),
    id: `rec_${randomUUID().replace(/-/g, '')}`,
  };
}

/**
 * 1. Operations Agent (Read-Only)
 * Inspects run queues, latency, failure rates, and recommends non-destructive retries.
 */
export class OperationsAgent {
  readonly type: SpecialistAgentType = 'OPERATIONS';

  diagnoseAgentRuns = async (
    workspaceId: string,
    recentRuns: Array<{ agentId: string; runId: string; status: 'completed' | 'failed' | 'running'; error?: string }>,
  ): Promise<AgentDiagnosisReport> => {
    const failedRuns = recentRuns.filter((r) => r.status === 'failed');
    const recommendations: ActionRecommendation[] = [];
    const findings: string[] = [];

    if (failedRuns.length === 0) {
      return {
        agentType: this.type,
        findings: ['All recent runs completed successfully.'],
        recommendations: [],
        status: 'HEALTHY',
        summary: `Workspace '${workspaceId}' agent operations are normal.`,
      };
    }

    findings.push(`Detected ${failedRuns.length} failed agent runs out of ${recentRuns.length} total.`);

    for (const failed of failedRuns) {
      recommendations.push(
        makeRecommendation({
          action: 'admin.agent.retry',
          agentType: this.type,
          confidence: 0.9,
          parameters: { reason: 'Automated retry recommendation for transient failure', runId: failed.runId },
          reasoning: `Run '${failed.runId}' failed with error: ${failed.error || 'Transient runtime exception'}. Retry is recommended.`,
          riskLevel: 'LOW',
          targetResource: failed.runId,
        }),
      );
    }

    return {
      agentType: this.type,
      findings,
      recommendations,
      status: failedRuns.length > 3 ? 'CRITICAL' : 'DEGRADED',
      summary: `Workspace '${workspaceId}' has ${failedRuns.length} failed runs requiring operator review.`,
    };
  };
}

/**
 * 2. Support Agent (Read-Only)
 * Diagnoses access, login, and permission issues for users within workspaces.
 */
export class SupportAgent {
  readonly type: SpecialistAgentType = 'SUPPORT';

  diagnoseUserAccess = async (params: {
    isBanned?: boolean;
    membershipRole?: string;
    userId: string;
    workspaceId: string;
  }): Promise<AgentDiagnosisReport> => {
    const recommendations: ActionRecommendation[] = [];
    const findings: string[] = [];

    if (params.isBanned) {
      findings.push(`User '${params.userId}' is currently marked as banned/suspended.`);
      return {
        agentType: this.type,
        findings,
        recommendations: [],
        status: 'CRITICAL',
        summary: `User '${params.userId}' is suspended and cannot access workspace '${params.workspaceId}'.`,
      };
    }

    if (!params.membershipRole) {
      findings.push(`User '${params.userId}' has no active membership in workspace '${params.workspaceId}'.`);
      return {
        agentType: this.type,
        findings,
        recommendations: [],
        status: 'DEGRADED',
        summary: `User '${params.userId}' lacks membership in workspace '${params.workspaceId}'. Invite or assign role.`,
      };
    }

    if (params.membershipRole === 'viewer') {
      findings.push('User has role "viewer" which restricts execution and authoring capabilities.');
    }

    return {
      agentType: this.type,
      findings,
      recommendations,
      status: 'HEALTHY',
      summary: `User '${params.userId}' has valid active access with role '${params.membershipRole}'.`,
    };
  };
}

/**
 * 3. Model Operations Agent (Read-Only)
 * Monitors candidate provider latency/availability and recommends routing switches or model disablement.
 */
export class ModelOperationsAgent {
  readonly type: SpecialistAgentType = 'MODEL_OPS';

  diagnoseModelHealth = async (
    catalog: ModelCatalogService,
    unhealthyProviders: string[],
  ): Promise<AgentDiagnosisReport> => {
    const recommendations: ActionRecommendation[] = [];
    const findings: string[] = [];
    const allModels = catalog.listModels({ enabledOnly: true });

    for (const model of allModels) {
      const activeCandidates = model.candidates.filter((c) => !unhealthyProviders.includes(c.provider));

      if (activeCandidates.length === 0) {
        findings.push(`Model '${model.id}' has ALL candidates unhealthy (${unhealthyProviders.join(', ')}).`);
        recommendations.push(
          makeRecommendation({
            action: 'admin.model.disable',
            agentType: this.type,
            confidence: 0.98,
            parameters: { modelId: model.id, reason: 'All provider candidates are currently down' },
            reasoning: `To prevent user request failures, temporarily disable '${model.id}'.`,
            riskLevel: 'MEDIUM',
            targetResource: model.id,
          }),
        );
      } else if (activeCandidates.length < model.candidates.length) {
        findings.push(
          `Model '${model.id}' is operating in degraded mode with remaining providers: ${activeCandidates.map((c) => c.provider).join(', ')}.`,
        );
      }
    }

    return {
      agentType: this.type,
      findings,
      recommendations,
      status: recommendations.length > 0 ? 'CRITICAL' : findings.length > 0 ? 'DEGRADED' : 'HEALTHY',
      summary: `Inspected ${allModels.length} models. ${recommendations.length} models require disablement.`,
    };
  };
}

/**
 * 4. Security Agent (Read-Only)
 * Audits authorization failures, cross-tenant denial spikes, and recommends isolation measures.
 */
export class SecurityAgent {
  readonly type: SpecialistAgentType = 'SECURITY';

  diagnoseSecurityAudit = async (
    auditLogs: Array<{ action: string; actorId?: string; ipAddress?: string; result: string; workspaceId: string }>,
  ): Promise<AgentDiagnosisReport> => {
    const denials = auditLogs.filter((l) => l.result === 'DENIED');
    const recommendations: ActionRecommendation[] = [];
    const findings: string[] = [];

    if (denials.length === 0) {
      return {
        agentType: this.type,
        findings: ['No unauthorized access attempts observed in audit sample.'],
        recommendations: [],
        status: 'HEALTHY',
        summary: 'Security posture is nominal with zero access denials.',
      };
    }

    // Group denials by actorId
    const denialsByActor = new Map<string, number>();
    for (const d of denials) {
      const actor = d.actorId || 'unknown';
      denialsByActor.set(actor, (denialsByActor.get(actor) || 0) + 1);
    }

    for (const [actorId, count] of denialsByActor.entries()) {
      if (count >= 3) {
        findings.push(`Actor '${actorId}' triggered ${count} permission denial events.`);
        recommendations.push(
          makeRecommendation({
            action: 'admin.user.suspend',
            agentType: this.type,
            confidence: 0.85,
            parameters: { reason: `High frequency access denials (${count} occurrences)`, userId: actorId },
            reasoning: `Repeated authorization failures suggest credential compromise or probing activity.`,
            riskLevel: 'HIGH',
            targetResource: actorId,
          }),
        );
      }
    }

    return {
      agentType: this.type,
      findings,
      recommendations,
      status: recommendations.length > 0 ? 'CRITICAL' : 'DEGRADED',
      summary: `Identified ${denials.length} access denial events across ${denialsByActor.size} actors.`,
    };
  };
}

/**
 * 5. Billing Agent (Read-Only)
 * Reviews credit balances, token consumption, and detects subscription delinquency.
 */
export class BillingAgent {
  readonly type: SpecialistAgentType = 'BILLING';

  diagnoseBillingStatus = async (params: {
    creditBalanceMicros: number;
    monthlyTokensLimit: number;
    monthlyTokensUsed: number;
    subscriptionStatus: 'active' | 'past_due' | 'canceled';
    workspaceId: string;
  }): Promise<AgentDiagnosisReport> => {
    const recommendations: ActionRecommendation[] = [];
    const findings: string[] = [];

    if (params.subscriptionStatus === 'past_due') {
      findings.push('Subscription payment is past due.');
      recommendations.push(
        makeRecommendation({
          action: 'admin.workspace.freeze',
          agentType: this.type,
          confidence: 0.95,
          parameters: { reason: 'Subscription payment past due beyond grace period', workspaceId: params.workspaceId },
          reasoning: 'Delinquent subscription requires temporary workspace freeze until resolved.',
          riskLevel: 'CRITICAL',
          targetResource: params.workspaceId,
        }),
      );
    }

    const tokenOverage = params.monthlyTokensUsed >= params.monthlyTokensLimit;
    if (tokenOverage) {
      findings.push(
        `Monthly tokens exceeded (${params.monthlyTokensUsed} / ${params.monthlyTokensLimit}). Credits available: ${params.creditBalanceMicros} micros.`,
      );
      if (params.creditBalanceMicros === 0) {
        findings.push('Tenant has zero credit balance; token requests are being blocked.');
      }
    }

    return {
      agentType: this.type,
      findings,
      recommendations,
      status: recommendations.length > 0 ? 'CRITICAL' : tokenOverage ? 'DEGRADED' : 'HEALTHY',
      summary: `Billing diagnosis for workspace '${params.workspaceId}': Status ${params.subscriptionStatus}.`,
    };
  };
}
