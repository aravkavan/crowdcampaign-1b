// Claude, via Anthropic's Messages API.
import { config } from '../../config.js';
import { AiError, postJson } from './request.js';

export async function askClaude({ system, prompt }) {
  const data = await postJson(
    'Claude',
    'https://api.anthropic.com/v1/messages',
    { 'x-api-key': config.ai.anthropicKey, 'anthropic-version': '2023-06-01' },
    {
      model: config.ai.anthropicModel,
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: prompt }],
    },
  );
  const text = (data?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text.trim()) throw new AiError('Claude returned an empty reply');
  return text;
}
