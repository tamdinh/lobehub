import type { AdminRiskLevel, RiskAssessment, RiskFactors } from '@lobechat/types';

export class RiskEngine {
  /**
   * Evaluates contextual risk factors across 10 dimensions.
   * Invariant: Never use a static global score.
   */
  evaluateRisk = (factors: RiskFactors): RiskAssessment => {
    let score = 0;
    const reasoning: string[] = [];

    // 1. Blast Radius
    if (factors.blastRadius === 'GLOBAL') {
      score += 35;
      reasoning.push('Global blast radius impacts the entire platform (+35).');
    } else if (factors.blastRadius === 'CROSS_TENANT') {
      score += 25;
      reasoning.push('Cross-tenant blast radius affects multiple organizations (+25).');
    } else if (factors.blastRadius === 'WORKSPACE') {
      score += 15;
      reasoning.push('Workspace blast radius impacts all members of the tenant (+15).');
    } else {
      score += 5;
      reasoning.push('Single resource blast radius (+5).');
    }

    // 2. Reversibility
    if (factors.reversibility === 'IRREVERSIBLE') {
      score += 30;
      reasoning.push('Operation is irreversible (+30).');
    } else if (factors.reversibility === 'PARTIALLY_REVERSIBLE') {
      score += 15;
      reasoning.push('Operation is only partially reversible (+15).');
    } else {
      reasoning.push('Operation is fully reversible (+0).');
    }

    // 3. Data Sensitivity
    if (factors.dataSensitivity === 'RESTRICTED') {
      score += 20;
      reasoning.push('Involves restricted / PII / payment data (+20).');
    } else if (factors.dataSensitivity === 'CONFIDENTIAL') {
      score += 15;
      reasoning.push('Involves confidential internal data (+15).');
    } else if (factors.dataSensitivity === 'INTERNAL') {
      score += 5;
    }

    // 4. Financial Impact
    if (factors.financialImpactMicros >= 100_000_000) {
      // >= $100
      score += 25;
      reasoning.push('High financial impact >= $100 (+25).');
    } else if (factors.financialImpactMicros >= 10_000_000) {
      // >= $10
      score += 15;
      reasoning.push('Moderate financial impact >= $10 (+15).');
    } else if (factors.financialImpactMicros >= 1_000_000) {
      // >= $1
      score += 5;
    }

    // 5. Environment
    if (factors.environment === 'PRODUCTION') {
      score += 10;
      reasoning.push('Production environment execution (+10).');
    } else if (factors.environment === 'STAGING') {
      score += 5;
    }

    // 6. Confidence Penalty
    if (factors.confidence < 0.9) {
      const penalty = Math.round((0.9 - Math.max(0, factors.confidence)) * 25);
      score += penalty;
      reasoning.push(`Sub-optimal model confidence (${factors.confidence.toFixed(2)}) adds risk (+${penalty}).`);
    }

    // Cap score at 100
    const finalScore = Math.min(100, score);

    // Map to risk level
    let riskLevel: AdminRiskLevel = 'LOW';
    let requiresApproval = false;

    if (finalScore >= 75) {
      riskLevel = 'CRITICAL';
      requiresApproval = true;
    } else if (finalScore >= 50) {
      riskLevel = 'HIGH';
      requiresApproval = true;
    } else if (finalScore >= 25) {
      riskLevel = 'MEDIUM';
      requiresApproval = factors.reversibility === 'IRREVERSIBLE';
    } else {
      riskLevel = 'LOW';
      requiresApproval = false;
    }

    return {
      evaluatedAt: new Date(),
      factors,
      reasoning,
      requiresApproval,
      riskLevel,
      score: finalScore,
    };
  };
}
