// Gemini, via Google's OpenAI-compatible endpoint (a stable, widely used request shape).
import { config } from '../../config.js';
import { AiError, postJson } from './request.js';

export async function askGemini({ system, prompt }) {
  const data = await postJson(
    'Gemini',
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    { authorization: `Bearer ${config.ai.geminiKey}` },
    {
      model: config.ai.geminiModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    },
  );
  const content = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : String(content ?? '');
  if (!text.trim()) throw new AiError('Gemini returned an empty reply');
  return text;
}
