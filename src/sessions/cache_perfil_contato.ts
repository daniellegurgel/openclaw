/**
 * Cache de perfil do contato — busca dados do cliente via webhook antes do LLM responder.
 *
 * Funciona assim:
 * 1. Mensagem chega no WhatsApp
 * 2. Antes de enviar ao LLM, o gateway verifica se já tem o perfil em cache
 * 3. Se não tem (ou expirou), chama o webhook (ex: n8n → Supabase)
 * 4. O JSON retornado é injetado no contexto da mensagem
 * 5. O LLM recebe a mensagem já sabendo quem é o remetente
 *
 * Criado por Danielle Gurgel — Neurotrading
 */

/** Entrada no cache: dados retornados pelo webhook + timestamp de quando foi buscado. */
type EntradaCache = {
  dados: string;
  buscadoEm: number;
};

/** Cache em memória: chave = telefone E.164, valor = dados + timestamp. */
const cache = new Map<string, EntradaCache>();

/** TTL padrão em minutos quando não configurado no openclaw.json. */
const TTL_PADRAO_MINUTOS = 30;

/** Timeout padrão em ms quando não configurado no openclaw.json. */
const TIMEOUT_PADRAO_MS = 4000;

/**
 * Busca o perfil do contato — retorna do cache se válido, senão chama o webhook.
 *
 * @returns string com os dados formatados para injeção, ou undefined se falhar/vazio.
 */
export async function buscarPerfilContato(params: {
  telefone: string;
  url: string;
  timeoutMs?: number;
  cacheTtlMinutes?: number;
}): Promise<string | undefined> {
  const ttlMs = (params.cacheTtlMinutes ?? TTL_PADRAO_MINUTOS) * 60_000;
  const agora = Date.now();

  // Verifica cache
  const entrada = cache.get(params.telefone);
  if (entrada && agora - entrada.buscadoEm < ttlMs) {
    return entrada.dados;
  }

  // Chama o webhook
  const timeoutMs = params.timeoutMs ?? TIMEOUT_PADRAO_MS;
  const urlCompleta = `${params.url}?phone=${encodeURIComponent(params.telefone)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const resposta = await fetch(urlCompleta, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);

    if (!resposta.ok) {
      return undefined;
    }

    const json = await resposta.json();

    // Webhook retornou vazio ou erro
    if (!json || (typeof json === "object" && Object.keys(json).length === 0)) {
      return undefined;
    }

    // Formata os dados como bloco de contexto legível pelo LLM
    const dados = formatarPerfil(json);
    if (!dados) {
      return undefined;
    }

    // Salva no cache
    cache.set(params.telefone, { dados, buscadoEm: agora });
    return dados;
  } catch {
    // Timeout ou erro de rede — não bloqueia o fluxo, LLM responde sem o perfil
    return undefined;
  }
}

/**
 * Formata o JSON retornado pelo webhook em texto legível para o LLM.
 * Transparente: qualquer campo retornado pelo webhook é incluído.
 */
function formatarPerfil(json: unknown): string | undefined {
  if (typeof json === "string") {
    return json.trim() || undefined;
  }

  if (Array.isArray(json)) {
    // Webhook pode retornar array — usa o primeiro elemento
    if (json.length === 0) return undefined;
    return formatarPerfil(json[0]);
  }

  if (typeof json === "object" && json !== null) {
    const linhas: string[] = [];
    for (const [chave, valor] of Object.entries(json)) {
      if (valor === null || valor === undefined || valor === "") continue;
      linhas.push(`${chave}: ${typeof valor === "object" ? JSON.stringify(valor) : String(valor)}`);
    }
    return linhas.length > 0 ? linhas.join("\n") : undefined;
  }

  return undefined;
}

/** Limpa todo o cache (útil para testes ou reinício). */
export function limparCache(): void {
  cache.clear();
}
