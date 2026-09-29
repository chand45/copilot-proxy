import { buildCopilotDynamicHeaders } from '@earendil-works/pi-ai/api/github-copilot-headers';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';

function isImage(part) {
  return ['image_url', 'input_image', 'image'].includes(part?.type);
}

function hasImages(body) {
  const messages = body?.messages ?? body?.input;
  if (!Array.isArray(messages)) return false;
  return messages.some(message => Array.isArray(message?.content)
    && message.content.some(part => isImage(part)
      || (part?.type === 'tool_result' && Array.isArray(part.content) && part.content.some(isImage))));
}

function copilotMessages(body) {
  const messages = body?.messages ?? body?.input;
  if (!Array.isArray(messages)) return [];
  // Native Anthropic tool results use a user role; Pi represents them separately.
  return messages.map(message => message?.role === 'user' && Array.isArray(message.content)
    && message.content.some(part => part?.type === 'tool_result')
    ? { ...message, role: 'toolResult' }
    : message);
}

export async function createPiIntegration() {
  const provider = githubCopilotProvider();
  const oauth = provider.auth?.oauth;
  if (!oauth) throw new Error('The installed Pi package does not expose GitHub Copilot OAuth.');
  const models = await provider.getModels();
  const fallbackHeaders = models.find(model => model.headers)?.headers;
  if (!fallbackHeaders) throw new Error('The installed Pi package has no Copilot request headers.');
  return {
    oauth,
    headersForRequest(body) {
      const model = body && models.find(model => model.id === body.model);
      return {
        ...(model?.headers || fallbackHeaders),
        ...buildCopilotDynamicHeaders({ messages: copilotMessages(body), hasImages: hasImages(body) }),
        ...(!body ? { 'X-GitHub-Api-Version': '2026-06-01' } : {}),
      };
    },
  };
}
