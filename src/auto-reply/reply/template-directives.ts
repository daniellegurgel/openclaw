import type { ReplyPayload } from "../types.js";

/**
 * Tipagem mínima do que a gente espera dentro de:
 * payload.channelData["api-meta"]
 *
 * Observação: isso NÃO precisa existir no payload.
 * A função só usa para:
 * - preservar campos já existentes (ex: idempotencyKey)
 * - evitar sobrescrever template se já veio pronto
 */
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
 * =============================================================================
 * parseTemplateDirective(payload)
 * =============================================================================
 *
 * Objetivo:
 * Permitir que o agente (LLM) indique que a primeira mensagem deve ser enviada
 * como TEMPLATE aprovado no WhatsApp Cloud API (Meta), em vez de texto livre.
 *
 * Exemplo de instrução no texto do agente:
 *
 *   [[template: prospeccao_fellipe_v1 | Paulo | Vi que você se interessou pelo Intensive]]
 *
 * Interpretação:
 * - "prospeccao_fellipe_v1"  → nome do template na Meta
 * - "Paulo"                 → variável {{1}}
 * - "Vi que você..."        → variável {{2}}
 *
 * O que a função faz:
 * 1) Procura no payload.text o bloco [[template: ...]]
 * 2) Extrai nome + variáveis separadas por "|"
 * 3) Remove esse bloco do texto (não aparece na conversa)
 * 4) Injeta em payload.channelData["api-meta"].template
 *
 * Por que isso é necessário:
 * - Para leads frios (fora da janela de 24h), a Meta bloqueia texto livre.
 * - A abertura precisa ser via template aprovado.
 *
 * Robustez adicionada (crítico):
 * - Não sobrescreve channelData["api-meta"] já existente (preserva idempotencyKey)
 * - Se já existe template no channelData, não reprocessa
 * - Regex segura: captura até "]]" (não quebra no primeiro "]")
 * - Filtra variáveis vazias (evita template inválido)
 */
export function parseTemplateDirective(payload: ReplyPayload): ReplyPayload {
  const text = payload.text;

  // Se não tem texto, não há nada para parsear.
  if (!text) return payload;

  // Lê o que já existe em channelData["api-meta"], se existir.
  // Isso é importante para NÃO apagar coisas como idempotencyKey.
  const existingApiMeta = payload.channelData?.["api-meta"] as ApiMetaChannelData | undefined;

  // Se alguém (n8n, caller, outro passo) já montou template,
  // não mexe. Evita duplicar ou alterar a instrução.
  if (existingApiMeta?.template?.name) {
    return payload;
  }

  /**
   * Regex:
   * - Procura literalmente: [[template: .... ]]
   * - Captura tudo entre "template:" e o fechamento "]]"
   * - ([\s\S]*?) é "qualquer coisa, inclusive newline, não guloso"
   *
   * Por que isso é melhor que [^\]]+ ?
   * Porque [^\]] para no primeiro ']' e pode truncar o conteúdo.
   */
  const match = text.match(/\[\[template:\s*([\s\S]*?)\]\]/i);
  if (!match) return payload;

  // Conteúdo dentro do bloco [[template: ... ]]
  const inner = match[1] ?? "";

  /**
   * Divide por "|":
   * - parts[0] = nome do template
   * - parts[1..] = variáveis
   *
   * trim() para tirar espaços.
   * filter() para remover itens vazios (ex: " |  | ").
   */
  const parts = inner
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const templateName = parts[0];

  // Se não tem nome de template, ignora (não monta channelData).
  if (!templateName) return payload;

  // Variáveis do template ({{1}}, {{2}}, ...), removendo vazias.
  const variables = parts.slice(1).filter((v) => v.length > 0);

  /**
   * Remove o(s) bloco(s) do texto.
   * A versão global (/gi) remove mais de um caso se o modelo repetir.
   * Depois trim() para limpar espaços sobrando.
   */
  const cleanText = text.replace(/\[\[template:[\s\S]*?\]\]/gi, "").trim();

  /**
   * Injeta no payload.channelData no formato que a extensão "api-meta" espera:
   *
   * channelData["api-meta"].template = {
   *   name: "prospeccao_fellipe_v1",
   *   language: "pt_BR",
   *   variables: ["Paulo", "Vi que você..."]
   * }
   *
   * Importante:
   * - preserva payload.channelData inteiro
   * - preserva também existingApiMeta (ex: idempotencyKey)
   * - variables pode ser undefined se não houver variáveis
   */
  return {
    ...payload,
    // Se sobrou texto fora do bloco, mantém; senão remove (undefined).
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
