/** `paper_read` 的声明：运行时 tools() 与自描述 describe 共用这一份。 */

export const PAPER_READ_DESCRIPTION =
  'Read one pushed paper: title, journal, authors, institution, DOI, source and abstract. '
  + 'Call this with the id from a news.item event before speaking about that paper.';

export const PAPER_READ_TAGS = ['read'] as const;

export const PAPER_READ_PARAMETERS = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const, description: 'The 8-character id carried by the news.item event.' },
  },
  required: ['id'],
};
