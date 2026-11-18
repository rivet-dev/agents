export type FeatureCoverageView = {
  unstable_methods?: boolean;
  planMode?: boolean;
  permissions?: boolean;
  questions?: boolean;
  toolCalls?: boolean;
  toolResults?: boolean;
  textMessages?: boolean;
  images?: boolean;
  fileAttachments?: boolean;
  sessionLifecycle?: boolean;
  errorEvents?: boolean;
  reasoning?: boolean;
  status?: boolean;
  commandExecution?: boolean;
  fileChanges?: boolean;
  mcpTools?: boolean;
  streamingDeltas?: boolean;
  itemStarted?: boolean;
  variants?: boolean;
  sharedProcess?: boolean;
};

export const emptyFeatureCoverage: FeatureCoverageView = {
  unstable_methods: false,
  planMode: false,
  permissions: false,
  questions: false,
  toolCalls: false,
  toolResults: false,
  textMessages: false,
  images: false,
  fileAttachments: false,
  sessionLifecycle: false,
  errorEvents: false,
  reasoning: false,
  status: false,
  commandExecution: false,
  fileChanges: false,
  mcpTools: false,
  streamingDeltas: false,
  itemStarted: false,
  variants: false,
  sharedProcess: false,
};
