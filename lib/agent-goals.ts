// The goals a campaign can have. Kept apart from lib/agent.ts so client code can import it
// without pulling in the research pipeline.
export const GOALS = ['seasonal', 'sale', 'launch', 'evergreen'] as const;
export type CampaignGoal = (typeof GOALS)[number];
