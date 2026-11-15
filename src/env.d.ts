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
