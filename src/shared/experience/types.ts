export interface ExperienceMilestone {
  id: string;
  label: string;
}

export interface ExperienceStep {
  id: string;
  title: string;
  instruction: string;
  capability: string;
  milestones: readonly ExperienceMilestone[];
}

export interface ExperienceScenario {
  id: string;
  label: string;
  path: string;
  description: string;
  status: 'ready' | 'planned';
  steps: readonly ExperienceStep[];
}

/** Scenario adapters report evidence; the shared view never completes tasks itself. */
export interface ExperienceProgress {
  scenarioId: string;
  milestones: readonly string[];
}
