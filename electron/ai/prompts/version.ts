export const PROMPT_VERSIONS=['journal-1','journal-2'] as const;
export type PromptVersion=typeof PROMPT_VERSIONS[number];
export const CURRENT_PROMPT:PromptVersion='journal-2';
