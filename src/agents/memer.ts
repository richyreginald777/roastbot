import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

// --- Prompt builder -----------------------------------------------------------
// Tuned for gemini-3.1-flash-lite-image ("Nano Banana 2 Lite") based on the
// official docs (ai.google.dev/gemini-api/docs/image-generation):
// - The model has RELIABLE text rendering and prompt adherence, but only at
//   1K resolution — SMALL text blurs. So: all text LARGE, few labels.
// - Google's recommended prompt style is descriptive narrative with the exact
//   text in quotes and the font described ("in a bold sans-serif font"),
//   not terse rule lists.
// - Aspect ratio is set via imageConfig (NOT prose), thinking level via
//   thinkingConfig — 'high' trades latency for much better composition.

function buildMemePrompt(caption: string, scene: string): string {
  return `Create a funny internet meme image.

Across the top of the image, render the text "${caption}" in a large, bold, white meme-style font with a thick black outline. This exact text, spelled exactly as written — it may contain Tamil or Tanglish words, so copy every word letter by letter.

The scene below the caption: ${scene || 'a simple cartoon that visualizes the caption literally, with no labels'}

The design is a flat cartoon illustration with thick outlines and bright, high-contrast colors. The composition is simple and bold with one clear focal point, instantly readable even as a small thumbnail. Every piece of text in the image is LARGE — never render small or fine print, it becomes illegible. Labels (if the scene names any) are 1-2 words in big bold capital letters placed directly on the object they belong to. Apart from the caption and those labels there is NO other text anywhere — no signs, posters, or screen text. Characters are generic cartoon people, never celebrities or real people. Keep it workplace-safe with no logos.`;
}

// --- Image generation --------------------------------------------------------------

export async function generateMemeImage(caption: string, scene: string): Promise<Buffer | null> {
  try {
    logger.info('Generating meme image...', { model: config.gemini.imageModel });
    const response = await ai.models.generateContent({
      model: config.gemini.imageModel,
      contents: buildMemePrompt(caption, scene),
      config: {
        // 4:3 reads as "meme" in a Slack thread; the model's default wide
        // frame produced letterboxed layouts with dead space
        imageConfig: { aspectRatio: '4:3' },
        // Default is MINIMAL; HIGH makes the model reason about composition
        // and text placement before rendering — worth the extra seconds
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
      },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      const data = (part as any).inlineData?.data;
      if (data) {
        logger.info('Meme image generated');
        return Buffer.from(data, 'base64');
      }
    }
    logger.warn('Image model returned no image part — falling back to text reply');
    return null;
  } catch (err: any) {
    // Meme failure must never kill the reply — caller falls back to text
    logger.error('Meme generation failed', { error: err.message });
    return null;
  }
}
