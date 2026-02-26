import type { ReplyPayload } from "../types.js";

type ApiMetaChannelData = {
  idempotencyKey?: string;
  template?: {
    name: string;
    language: string;
    variables?: string[];
  };
  [k: string]: unknown;
};

/**
 * Quando ele quer mandar essa primeira mensagem, ele escreve na resposta dele:
 *
 *   [[template: prospeccao_fellipe_v1 | Paulo | Vi que você se interessou pelo Intensive]]
 *
 * A função:
 * - Extrai template + variáveis
 * - Injeta em channelData["api-meta"].template
 * - Remove o bloco do texto (não aparece no chat)
 */
export function parseTemplateDirective(payload: ReplyPayload): ReplyPayload {
  const text = payload.text;
  if (!text) return payload;

  // Se já existe template no channelData, respeita e não reprocessa
  const existingApiMeta = payload.channelData?.["api-meta"] as
    | ApiMetaChannelData
    | undefined;
  if (existingApiMeta?.template?.name) {
    return payload;
  }

  // Captura apenas até o fechamento "]]" (não para no primeiro "]")
  // Ex: [[template: name | var1 | var2]]
  const match = text.match(/\[\[template:\s*([\s\S]*?)\]\]/i);
  if (!match) return payload;

  const inner = match[1] ?? "";
  const parts = inner
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const templateName = parts[0];
  if (!templateName) return payload;

  const variables = parts.slice(1).filter((v) => v.length > 0);

  // Remove o(s) bloco(s) [[template:...]] do texto
  const cleanText = text
    .replace(/\[\[template:[\s\S]*?\]\]/gi, "")
    .trim();

  return {
    ...payload,
    text: cleanText || undefined,
    channelData: {
      ...payload.channelData,
      "api-meta": {
        ...(existingApiMeta ?? {}),
        template: {
          name: templateName,
          language: "pt_BR",
          variables: variables.length ? variables : undefined,
        },
      },
    },
  };
}
