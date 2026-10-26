/** 额度 World 的工具参数：tools() 与自描述 describe 共用，避免两处漂移。 */

export const QUOTA_STATUS_PARAMETERS = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {},
};

export const QUOTA_HERMES_PARAMETERS = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    days: {
      type: 'integer' as const,
      description: 'How many days back to total. Defaults to the configured range (7).',
      minimum: 1,
      maximum: 90,
    },
  },
};

export const QUOTA_TOOL_TAGS = ['read'] as const;
