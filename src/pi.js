import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';

function hasImages(body) {
  const messages = body?.messages ?? body?.input;
  if (!Array.isArray(messages)) return false;
  return messages.some(message => Array.isArray(message?.content)
    && message.content.some(part => ['image_url', 'input_image', 'image'].includes(part?.type)));
}

function initiator(body) {
  const messages = body?.messages ?? body?.input;
  if (typeof messages === 'string' || !Array.isArray(messages) || messages.length === 0) return 'user';
  const last = messages.at(-1);
  return last?.role === 'user' ? 'user' : 'agent';
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
        'X-Initiator': initiator(body),
        'Openai-Intent': 'conversation-edits',
        ...(hasImages(body) ? { 'Copilot-Vision-Request': 'true' } : {}),
        ...(!body ? { 'X-GitHub-Api-Version': '2026-06-01' } : {}),
      };
    },
  };
}
