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

/**
 * Entrada no cache: dados retornados pelo webhook + timestamp + status.
 * O status "vazio" e "erro" funcionam como sentinela — evitam refetch em loop
 * quando o webhook falha ou não encontra o contato.
 */
type EntradaCache = {
  dados?: string;
  status: "ok" | "vazio" | "erro";
  buscadoEm: number;
};

/** Cache em memória: chave = telefone E.164, valor = dados + timestamp + status. */
const cache = new Map<string, EntradaCache>();

/** TTL padrão em minutos para perfil encontrado (quando não configurado no openclaw.json). */
const TTL_PADRAO_MINUTOS = 30;

/** TTL para sentinela de falha/vazio — evita martelar o webhook. */
const TTL_SENTINELA_MS = 2 * 60_000; // 2 minutos

/** Timeout padrão em ms quando não configurado no openclaw.json. */
const TIMEOUT_PADRAO_MS = 4000;

/** Limite máximo de caracteres na saída formatada para não estourar o prompt. */
const MAX_CHARS_PERFIL = 2000;

/** Limite máximo de entradas no cache — evita crescimento infinito em memória. */
const MAX_ENTRADAS_CACHE = 5000;

/** Intervalo entre limpezas automáticas de entradas expiradas (10 minutos). */
const INTERVALO_LIMPEZA_MS = 10 * 60_000;

/** Timestamp da última limpeza automática. */
let ultimaLimpeza = Date.now();

/**
 * Busca o perfil do contato — retorna do cache se válido, senão chama o webhook.
 *
 * Comportamento de proteção:
 * - Se o webhook falha ou retorna vazio, cacheia uma sentinela por 2min (não refaz fetch).
 * - Se o cache passar de 5000 entradas, remove as mais antigas.
 * - Se o perfil formatado passar de 2000 chars, trunca.
 *
 * @returns string com os dados formatados para injeção, ou undefined se falhar/vazio.
 */
export async function buscarPerfilContato(params: {
  telefone: string;
  url: string;
  timeoutMs?: number;
  cacheTtlMinutes?: number;
  warn?: (msg: string) => void;
}): Promise<string | undefined> {
  const ttlMs = (params.cacheTtlMinutes ?? TTL_PADRAO_MINUTOS) * 60_000;
  const agora = Date.now();

  // Limpeza periódica de entradas expiradas
  if (agora - ultimaLimpeza > INTERVALO_LIMPEZA_MS) {
    limparExpirados(ttlMs);
    ultimaLimpeza = agora;
  }

  // Verifica cache
  const entrada = cache.get(params.telefone);
  if (entrada) {
    const ttlEntrada = entrada.status === "ok" ? ttlMs : TTL_SENTINELA_MS;
    if (agora - entrada.buscadoEm < ttlEntrada) {
      return entrada.dados;
    }
  }

  // Constrói URL de forma segura (suporta URLs que já tenham query params)
  const timeoutMs = params.timeoutMs ?? TIMEOUT_PADRAO_MS;
  let urlCompleta: string;
  try {
    const u = new URL(params.url);
    u.searchParams.set("phone", params.telefone);
    urlCompleta = u.toString();
  } catch {
    params.warn?.(`[contact-lookup] URL inválida: ${params.url}`);
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resposta = await fetch(urlCompleta, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!resposta.ok) {
      cache.set(params.telefone, { status: "erro", buscadoEm: agora });
      params.warn?.(
        `[contact-lookup] webhook retornou ${resposta.status} para ${params.telefone}`,
      );
      return undefined;
    }

    // Lê como texto primeiro para evitar explosão em body não-JSON
    const texto = await resposta.text();
    let json: unknown;
    try {
      json = JSON.parse(texto);
    } catch {
      cache.set(params.telefone, { status: "erro", buscadoEm: agora });
      params.warn?.(
        `[contact-lookup] resposta não é JSON válido para ${params.telefone}`,
      );
      return undefined;
    }

    // Webhook retornou vazio
    if (!json || (typeof json === "object" && Object.keys(json as object).length === 0)) {
      cache.set(params.telefone, { status: "vazio", buscadoEm: agora });
      return undefined;
    }

    // Formata os dados como bloco de contexto legível pelo LLM
    const dados = formatarPerfil(json);
    if (!dados) {
      cache.set(params.telefone, { status: "vazio", buscadoEm: agora });
      return undefined;
    }

    // Salva no cache (com eviction se necessário)
    if (cache.size >= MAX_ENTRADAS_CACHE) {
      evictarMaisAntigo();
    }
    cache.set(params.telefone, { dados, status: "ok", buscadoEm: agora });
    return dados;
  } catch (err: unknown) {
    // Timeout, DNS, erro de rede — cacheia sentinela e loga
    cache.set(params.telefone, { status: "erro", buscadoEm: agora });
    const motivo =
      err instanceof Error
        ? err.name === "AbortError"
          ? `timeout (${timeoutMs}ms)`
          : err.message
        : "erro desconhecido";
    params.warn?.(`[contact-lookup] falha para ${params.telefone}: ${motivo}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Formata o JSON retornado pelo webhook em texto legível para o LLM.
 * Transparente: qualquer campo retornado pelo webhook é incluído.
 * Limita a saída a MAX_CHARS_PERFIL para proteger o prompt.
 */
function formatarPerfil(json: unknown): string | undefined {
  if (typeof json === "string") {
    const texto = json.trim();
    return texto ? texto.slice(0, MAX_CHARS_PERFIL) : undefined;
  }

  if (Array.isArray(json)) {
    // Webhook pode retornar array — usa o primeiro elemento
    if (json.length === 0) return undefined;
    return formatarPerfil(json[0]);
  }

  if (typeof json === "object" && json !== null) {
    const linhas: string[] = [];
    let totalChars = 0;
    for (const [chave, valor] of Object.entries(json)) {
      if (valor === null || valor === undefined || valor === "") continue;
      const valorStr = typeof valor === "object" ? JSON.stringify(valor) : String(valor);
      // Trunca valores individuais muito longos
      const valorTruncado = valorStr.length > 500 ? valorStr.slice(0, 500) + "..." : valorStr;
      const linha = `${chave}: ${valorTruncado}`;
      totalChars += linha.length + 1;
      if (totalChars > MAX_CHARS_PERFIL) break;
      linhas.push(linha);
    }
    return linhas.length > 0 ? linhas.join("\n") : undefined;
  }

  return undefined;
}

/** Remove a entrada mais antiga do cache (eviction simples). */
function evictarMaisAntigo(): void {
  let chaveAntiga: string | undefined;
  let tsAntigo = Infinity;
  for (const [chave, entrada] of cache) {
    if (entrada.buscadoEm < tsAntigo) {
      tsAntigo = entrada.buscadoEm;
      chaveAntiga = chave;
    }
  }
  if (chaveAntiga) {
    cache.delete(chaveAntiga);
  }
}

/** Remove entradas expiradas do cache (limpeza periódica). */
function limparExpirados(ttlOkMs: number): void {
  const agora = Date.now();
  for (const [chave, entrada] of cache) {
    const ttl = entrada.status === "ok" ? ttlOkMs : TTL_SENTINELA_MS;
    if (agora - entrada.buscadoEm >= ttl) {
      cache.delete(chave);
    }
  }
}

/** Limpa todo o cache (útil para testes ou reinício). */
export function limparCache(): void {
  cache.clear();
}
