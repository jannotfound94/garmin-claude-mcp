// Secrets and bindings. Secrets are set in Cloudflare (Settings > Variables and Secrets) or with `wrangler secret put`.
interface CoachEnv {
  INTERVALS_API_KEY: string;
  INTERVALS_ATHLETE_ID: string;
  MCP_PASSWORD: string;
  // Coach agent (optional until you set them up, see SETUP-TRENER.md)
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ROUTINE_FIRE_URL?: string;
  ROUTINE_FIRE_TOKEN?: string;
  GARMIN_PERSONAL_API_KEY?: string;
  ORS_API_KEY?: string;
  // Dietetyk (opcjonalny): darmowy klucz z Google AI Studio. Modele można podmienić bez zmiany kodu.
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_FALLBACK_MODEL?: string;
  // Zapasowy dostawca rozpoznawania posiłków (opcjonalny): klucz z console.anthropic.com. FOOD_PRIMARY=claude zaczyna od Claude.
  ANTHROPIC_API_KEY?: string;
  CLAUDE_FOOD_MODEL?: string;
  FOOD_PRIMARY?: string;
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  COACH_STATE: DurableObjectNamespace<import("./state").CoachState>;
}
interface Env extends CoachEnv {}
declare namespace Cloudflare {
  interface Env extends CoachEnv {}
}
declare module "*.md" {
  const content: string;
  export default content;
}
