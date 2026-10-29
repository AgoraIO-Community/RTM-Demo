import type { ExperienceProgress, ExperienceScenario } from './types';

/** Keep displayed progress and analytics on the same evidence contract. */
export function completedExperienceSteps(scenario?: ExperienceScenario, progress?: ExperienceProgress) {
  const evidence = new Set(progress?.scenarioId === scenario?.id ? progress?.milestones : []);
  return (scenario?.steps ?? []).filter(step => step.milestones.length > 0
    && step.milestones.every(milestone => evidence.has(milestone.id)));
}
