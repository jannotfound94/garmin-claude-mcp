#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { odpis, biuletyn, normalizeKrs, KrsError } from "./krs-client.js";
import { summarize } from "./summary.js";

const MAX_CHARS = Number(process.env.KRS_MAX_CHARS || 60000);

const text = (obj) => {
  let s = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS) + `\n…[ucięto, ${s.length - MAX_CHARS} znaków; użyj trybu "podsumowanie"]`;
  return { content: [{ type: "text", text: s }] };
};
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e instanceof KrsError ? e.message : `Błąd: ${e?.message ?? e}` }] });
const wrap = (fn) => async (args) => { try { return await fn(args); } catch (e) { return fail(e); } };

const krsArg = z.string().describe("Numer KRS (do 10 cyfr, z zerami wiodącymi lub bez)");
const rejestrArg = z.enum(["P", "S"]).default("P").describe("P = rejestr przedsiębiorców, S = stowarzyszeń i innych organizacji");
const trybArg = z.enum(["podsumowanie", "raw"]).default("podsumowanie").describe("podsumowanie = kluczowe pola; raw = pełny JSON z API");

export function buildServer() {
  const server = new McpServer({ name: "krs-mcp", version: "0.1.0" });

  server.tool(
    "krs_odpis_aktualny",
    "Odpis aktualny z KRS dla podanego numeru: nazwa, forma prawna, NIP/REGON, siedziba, kapitał, organ reprezentacji i skład zarządu, wspólnicy.",
    { krs: krsArg, rejestr: rejestrArg, tryb: trybArg },
    wrap(async ({ krs, rejestr, tryb }) => {
      const json = await odpis("aktualny", krs, rejestr);
      return text(tryb === "raw" ? json : summarize(json));
    }),
  );

  server.tool(
    "krs_odpis_pelny",
    "Odpis pełny z KRS (z historią wpisów). Odpowiedź bywa bardzo duża – domyślnie zwraca podsumowanie.",
    { krs: krsArg, rejestr: rejestrArg, tryb: trybArg },
    wrap(async ({ krs, rejestr, tryb }) => {
      const json = await odpis("pelny", krs, rejestr);
      return text(tryb === "raw" ? json : summarize(json));
    }),
  );

  server.tool(
    "krs_biuletyn",
    "Lista zmian wpisanych do KRS w danym dniu (Biuletyn). Przydatne do monitorowania zmian w spółkach.",
    { data: z.string().describe("Data w formacie YYYY-MM-DD") },
    wrap(async ({ data }) => text(await biuletyn(data))),
  );

  server.tool(
    "krs_waliduj_numer",
    "Normalizuje numer KRS do 10 cyfr (lokalnie, bez wywołania API).",
    { krs: krsArg },
    wrap(async ({ krs }) => text({ krs: normalizeKrs(krs) })),
  );

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildServer().connect(new StdioServerTransport());
}
