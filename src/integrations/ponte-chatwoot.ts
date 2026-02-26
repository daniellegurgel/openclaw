/**
 * =============================================================================
 * PONTE CHATWOOT — Espelhamento de mensagens WhatsApp ↔ Chatwoot
 * =============================================================================
 *
 * Autora: Daniele Gurgel
 * Criado em: 2026-02-20
 * Refatorado em: 2026-02-20 — renomeação para português e documentação extensiva.
 * Correções em: 2026-02-20 — normalização de telefone, cache seguro, log com
 *   stack, sanitização de baseUrl. (revisão de código por colega)
 *
 * -----------------------------------------------------------------------------
 * CONTEXTO DE NEGÓCIO
 * -----------------------------------------------------------------------------
 * O Chatwoot é o HUB de monitoramento da Neurotrading. Ele permite que a equipe
 * acompanhe em tempo real todas as conversas do WhatsApp num painel web
 * (chat.neurotrading.com.br).
 *
 * Porém, o Chatwoot e o OpenClaw são sistemas independentes — eles não se
 * conhecem nativamente. Este arquivo é a PONTE que conecta os dois.
 *
 * Funcionamento:
 *   - Toda vez que uma mensagem entra (cliente → bot) ou sai (bot → cliente)
 *     pelo WhatsApp, este módulo FAZ UMA CÓPIA e envia pro Chatwoot via API REST.
 *   - É "fire-and-forget": se o Chatwoot estiver fora do ar, o bot continua
 *     normalmente. A cópia falha silenciosamente e só grava um log de aviso.
 *   - O Chatwoot recebe as mensagens como se fosse um canal API (inbox tipo API).
 *
 * Analogia: é como uma câmera de segurança na porta — toda mensagem que passa,
 * a câmera tira uma foto e manda pro monitor. Se o monitor estiver desligado,
 * a porta continua funcionando normalmente.
 *
 * -----------------------------------------------------------------------------
 * CONTEXTO TÉCNICO
 * -----------------------------------------------------------------------------
 * - Usa a API REST v1 do Chatwoot para criar contatos, conversas e mensagens.
 * - Mantém cache em memória (Map) de contatos e conversas para evitar chamadas
 *   repetidas à API do Chatwoot.
 * - As funções públicas (espelharMensagemEntrada / espelharMensagemSaida) são
 *   síncronas (retornam void) e disparam a Promise internamente com void.
 *   Isso garante que NUNCA bloqueiam o fluxo principal do bot.
 *
 * Configuração via openclaw.json:
 *   integrations.chatwoot.enabled   : true
 *   integrations.chatwoot.baseUrl   : "http://localhost:3000"
 *   integrations.chatwoot.apiToken  : "<user_access_token>"
 *   integrations.chatwoot.accountId : 1
 *   integrations.chatwoot.inboxId   : 1
 *
 * =============================================================================
 */

import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { activateHandoff, deactivateHandoff } from "../sessions/handoff-store.js";

const log = createSubsystemLogger("ponte-chatwoot");

// =============================================================================
// Tipo de configuração do Chatwoot
// (mantido em inglês por consistência com OpenClawConfig / schema Zod)
// =============================================================================
export type ChatwootConfig = {
  enabled?: boolean;
  baseUrl?: string;
  apiToken?: string;
  accountId?: number;
  inboxId?: number;
};

// =============================================================================
// Cache com TTL e limite de entradas (Danielle Gurgel, 2026-02-25)
// Substitui Map<string,number> puro para evitar crescimento indefinido.
// TTL padrão 24h; ao atingir maxEntradas, expira expirados e depois os
// mais antigos (FIFO do Map, que mantém ordem de inserção).
// =============================================================================
class CacheTTL<K, V> {
  private mapa = new Map<K, { valor: V; expira: number }>();
  private readonly ttlMs: number;
  private readonly maxEntradas: number;

  constructor(ttlMinutos: number, maxEntradas: number = 10_000) {
    this.ttlMs = ttlMinutos * 60_000;
    this.maxEntradas = maxEntradas;
  }

  get(chave: K): V | undefined {
    const entrada = this.mapa.get(chave);
    if (!entrada) {
      return undefined;
    }
    if (Date.now() > entrada.expira) {
      this.mapa.delete(chave);
      return undefined;
    }
    return entrada.valor;
  }

  set(chave: K, valor: V): void {
    if (this.mapa.size >= this.maxEntradas) {
      this.evictar();
    }
    this.mapa.set(chave, { valor, expira: Date.now() + this.ttlMs });
  }

  delete(chave: K): void {
    this.mapa.delete(chave);
  }

  /** Remove expirados; se ainda cheio, descarta os 20% mais antigos (FIFO). */
  private evictar(): void {
    const agora = Date.now();
    for (const [k, v] of this.mapa) {
      if (agora > v.expira) {
        this.mapa.delete(k);
      }
    }
    if (this.mapa.size >= this.maxEntradas) {
      const excesso = this.mapa.size - Math.floor(this.maxEntradas * 0.8);
      let removidos = 0;
      for (const k of this.mapa.keys()) {
        if (removidos >= excesso) {
          break;
        }
        this.mapa.delete(k);
        removidos++;
      }
    }
  }
}

// =============================================================================
// Caches em memória com TTL (telefone normalizado → id do Chatwoot)
// Evita chamadas repetidas à API para o mesmo contato/conversa.
// A chave é SEMPRE o telefone normalizado via normalizarTelefoneE164().
// TTL 24h + max 10k entradas para evitar crescimento indefinido.
// (Danielle Gurgel, 2026-02-25)
// =============================================================================
const CACHE_TTL_MINUTOS = 1440; // 24h
const CACHE_MAX_ENTRADAS = 10_000;
const cacheContatos = new CacheTTL<string, number>(CACHE_TTL_MINUTOS, CACHE_MAX_ENTRADAS);
const cacheConversas = new CacheTTL<string, number>(CACHE_TTL_MINUTOS, CACHE_MAX_ENTRADAS);

// =============================================================================
// Funções internas (helpers)
// =============================================================================

/**
 * Normaliza um telefone para formato E.164 puro (só dígitos, sem +, sem @).
 * Essa função é CRÍTICA para evitar duplicação de contatos/conversas no cache.
 *
 * Inclui correção do 9° dígito para celulares brasileiros: o JID do WhatsApp
 * às vezes omite o "9" adicionado pela Anatel (ex: 558486340456 → 5584986340456).
 *
 * Exemplos:
 *   "+5511999999999"               → "5511999999999"  (já tem 9°, 13 dígitos)
 *   "558486340456"                 → "5584986340456"   (insere 9° dígito)
 *   "5511999999999@s.whatsapp.net" → "5511999999999"
 *   "55 11 99999-9999"             → "5511999999999"
 *   "447911123456"                 → "447911123456"    (não-BR, sem mudança)
 *
 * Danielle Gurgel, 2026-02-25
 */
function normalizarTelefoneE164(phone: string): string {
  // Remove sufixo de JID (@s.whatsapp.net, @c.us, etc)
  const semJid = phone.split("@")[0];
  // Remove tudo que não for dígito
  const digitos = semJid.replace(/\D/g, "");

  // Correção do 9° dígito para celulares brasileiros (Danielle Gurgel, 2026-02-25)
  // JID do WhatsApp pode vir sem o 9: 55 + DDD(2) + 8 dígitos = 12 dígitos total
  // Formato correto E.164:            55 + DDD(2) + 9 + 8 dígitos = 13 dígitos
  if (digitos.length === 12 && digitos.startsWith("55")) {
    return digitos.slice(0, 4) + "9" + digitos.slice(4);
  }

  return digitos;
}

/**
 * Valida telefone normalizado: só dígitos, comprimento entre 10 (mínimo
 * nacional sem código de país) e 15 (máximo E.164).
 * Retorna true se válido. (Danielle Gurgel, 2026-02-25)
 */
function telefoneValido(telefoneNormalizado: string): boolean {
  // Defesa extra: garante que é só dígitos (mesmo que normalizarTelefoneE164 já faça isso)
  if (!/^\d+$/.test(telefoneNormalizado)) return false;
  return telefoneNormalizado.length >= 10 && telefoneNormalizado.length <= 15;
}

/**
 * Ofusca telefone para logs: "5511999999999" → "5511****99999".
 * Preserva DDD (4 primeiros) e sufixo (5 últimos), mascara o meio.
 * (Danielle Gurgel, 2026-02-25)
 */
function mascararTelefone(tel: string): string {
  if (tel.length <= 8) {
    return "****";
  }
  return tel.slice(0, 4) + "****" + tel.slice(-5);
}

/** Limita senderName a 100 caracteres para evitar payloads abusivos. */
const MAX_SENDER_NAME = 100;
function sanitizarNome(nome: string | undefined): string | undefined {
  if (!nome) {
    return undefined;
  }
  const limpo = nome.trim();
  if (limpo.length <= MAX_SENDER_NAME) {
    return limpo;
  }
  return limpo.slice(0, MAX_SENDER_NAME);
}

/** Limita texto de mensagem a 6000 caracteres (Chatwoot aceita mais, mas
 *  previne payloads gigantes de input mal-formado). */
const MAX_TEXTO_MSG = 6000;
function sanitizarTexto(texto: string): string {
  if (texto.length <= MAX_TEXTO_MSG) {
    return texto;
  }
  return texto.slice(0, MAX_TEXTO_MSG) + "…[truncado]";
}

/**
 * Obtém a configuração do Chatwoot a partir do config geral do OpenClaw.
 * Retorna null se a integração estiver desabilitada ou incompleta.
 */
function obterConfigChatwoot(cfg: {
  integrations?: { chatwoot?: ChatwootConfig };
}): ChatwootConfig | null {
  const cw = cfg.integrations?.chatwoot;
  if (!cw?.enabled || !cw.baseUrl || !cw.apiToken || !cw.accountId || !cw.inboxId) {
    return null;
  }
  return cw;
}

/**
 * Faz uma requisição HTTP à API REST do Chatwoot.
 * Monta a URL completa a partir do baseUrl + accountId + path.
 * Lança erro se a resposta não for 2xx.
 * Timeout de 5 segundos para evitar acúmulo de Promises se o Chatwoot travar.
 */
async function requisicaoChatwoot(
  cw: ChatwootConfig,
  path: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  // Correção item 8: remove trailing slash da baseUrl para evitar URL com //
  const baseUrl = cw.baseUrl!.replace(/\/+$/, "");
  const url = `${baseUrl}/api/v1/accounts/${cw.accountId}${path}`;

  // Correção item 5: timeout de 5s para evitar "fire-and-leak".
  // Se o Chatwoot não responder em 5s, aborta a requisição.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        api_access_token: cw.apiToken!,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Chatwoot ${method} ${path} → ${res.status}: ${text}`);
    }
    // Correção item 4: resposta 204 (No Content) não tem body JSON
    if (res.status === 204) return null;
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Guard de concorrência: se duas mensagens do mesmo número chegam ao mesmo tempo,
// a segunda espera a primeira terminar em vez de criar contato duplicado.
// (Danielle Gurgel, 2026-02-25)
const contatoEmVoo = new Map<string, Promise<number>>();

/**
 * Busca um contato no Chatwoot pelo telefone. Se não encontrar, cria um novo.
 * Usa cache em memória para evitar buscas repetidas.
 * Guard de concorrência: dedup por Promise se já há uma busca em andamento.
 *
 * Lógica de negócio: cada número de WhatsApp corresponde a um contato no
 * Chatwoot. O contato é associado ao inbox (canal API) configurado.
 */
async function buscarOuCriarContato(
  cw: ChatwootConfig,
  phone: string,
  name?: string,
): Promise<number> {
  const telefoneNormalizado = normalizarTelefoneE164(phone);

  // Validação de comprimento (10-15 dígitos) — rejeita lixo antes de tocar API
  if (!telefoneValido(telefoneNormalizado)) {
    throw new Error(
      `Telefone inválido após normalização: "${mascararTelefone(
        telefoneNormalizado,
      )}" (len=${telefoneNormalizado.length})`,
    );
  }

  // Sanitiza nome se presente (max 100 chars)
  const nomeSanitizado = sanitizarNome(name);

  // Cache hit → retorno imediato
  const cached = cacheContatos.get(telefoneNormalizado);
  if (cached !== undefined) {
    return cached;
  }

  // Guard de concorrência: se já há uma busca em andamento para este número,
  // espera ela terminar em vez de disparar busca/criação paralela duplicada.
  const emVoo = contatoEmVoo.get(telefoneNormalizado);
  if (emVoo) {
    return emVoo;
  }

  const promessa = buscarOuCriarContatoInterno(cw, telefoneNormalizado, nomeSanitizado);
  contatoEmVoo.set(telefoneNormalizado, promessa);
  try {
    return await promessa;
  } finally {
    contatoEmVoo.delete(telefoneNormalizado);
  }
}

/** Implementação interna — separada para o guard de concorrência. */
async function buscarOuCriarContatoInterno(
  cw: ChatwootConfig,
  telefoneNormalizado: string,
  nomeSanitizado: string | undefined,
): Promise<number> {
  // ---------------------------------------------------------------------------
  // FIX DE RAIZ (2026-02-25):
  // O outbound chega como JID normalizado ("5511..."), mas o contato importado
  // costuma estar salvo como "+5511...". A busca textual do Chatwoot pode falhar
  // se o "q" não bater com o formato armazenado.
  //
  // Solução cirúrgica:
  //   - Buscar de forma determinística com 2 queries: sem "+" e com "+"
  //   - Validar match comparando SOMENTE dígitos (fone do contato vs normalizado)
  //   - Se encontrar e houver "name", atualizar nome quando ele for vazio ou
  //     quando ele for só o telefone (defesa adicional, sem depender de "cosmética")
  // ---------------------------------------------------------------------------

  const queries = [telefoneNormalizado, `+${telefoneNormalizado}`];

  for (const q of queries) {
    try {
      const resultado = (await requisicaoChatwoot(
        cw,
        `/contacts/search?q=${encodeURIComponent(q)}&include_contacts=true`,
        "GET",
      )) as {
        payload?: Array<{ id: number; name?: string; phone_number?: string }>;
      };

      const encontrado = resultado.payload?.find((c) => {
        const telContato = (c.phone_number ?? "").replace(/\D/g, "");
        return telContato === telefoneNormalizado;
      });

      if (encontrado) {
        cacheContatos.set(telefoneNormalizado, encontrado.id);

        // Defesa: se temos um nome real e o contato está com nome vazio
        // ou nome = telefone, atualiza o nome (não bloqueia fluxo se falhar).
        if (nomeSanitizado) {
          const nomeAtual = (encontrado.name ?? "").trim();
          const nomeAtualEhTelefone = nomeAtual.replace(/\D/g, "") === telefoneNormalizado;
          const nomeVazio = nomeAtual.length === 0;

          if (nomeVazio || nomeAtualEhTelefone) {
            try {
              await requisicaoChatwoot(cw, `/contacts/${encontrado.id}`, "PUT", {
                name: nomeSanitizado,
              });
            } catch {
              // best-effort — nunca quebra o espelhamento
            }
          }
        }

        return encontrado.id;
      }
    } catch {
      // tenta próxima query
    }
  }

  // Cria contato novo no Chatwoot (sempre com + na frente, padrão E.164)
  const contato = (await requisicaoChatwoot(cw, "/contacts", "POST", {
    inbox_id: cw.inboxId,
    name: nomeSanitizado || `+${telefoneNormalizado}`,
    phone_number: `+${telefoneNormalizado}`,
    // Identificador estável (opcional, mas ajuda futuras correções/migrações)
    identifier: `wa:${telefoneNormalizado}`,
  })) as { payload?: { contact?: { id: number } } };

  const id = contato.payload?.contact?.id;
  if (!id) throw new Error("Falha ao criar contato no Chatwoot");
  cacheContatos.set(telefoneNormalizado, id);
  return id;
}

/**
 * Busca uma conversa aberta no Chatwoot para o contato. Se não encontrar, cria.
 * Usa cache em memória para evitar buscas repetidas.
 *
 * Lógica de negócio: cada contato tem no máximo uma conversa aberta por inbox.
 * Se a conversa anterior foi "resolved" (encerrada), cria uma nova.
 */
async function buscarOuCriarConversa(
  cw: ChatwootConfig,
  contactId: number,
  phone: string,
): Promise<number> {
  // Correção item 1: normaliza telefone como chave do cache
  const telefoneNormalizado = normalizarTelefoneE164(phone);

  // Correção item 7: usar !== undefined
  const cached = cacheConversas.get(telefoneNormalizado);
  if (cached !== undefined) return cached;

  // Busca conversas abertas desse contato neste inbox
  try {
    const convs = (await requisicaoChatwoot(cw, `/contacts/${contactId}/conversations`, "GET")) as {
      payload?: Array<{ id: number; inbox_id: number; status: string }>;
    };
    const encontrada = convs.payload?.find(
      (c) => c.inbox_id === cw.inboxId && c.status !== "resolved",
    );
    if (encontrada) {
      cacheConversas.set(telefoneNormalizado, encontrada.id);
      return encontrada.id;
    }
  } catch {
    // Busca falhou
  }

  // Cria conversa nova
  const conv = (await requisicaoChatwoot(cw, "/conversations", "POST", {
    contact_id: contactId,
    inbox_id: cw.inboxId,
    status: "open",
  })) as { id?: number };

  const id = conv.id;
  if (!id) throw new Error("Falha ao criar conversa no Chatwoot");
  cacheConversas.set(telefoneNormalizado, id);
  return id;
}

// =============================================================================
// API PÚBLICA — funções exportadas (fire-and-forget)
// =============================================================================

/**
 * Espelha uma mensagem de ENTRADA (cliente → bot) no Chatwoot.
 *
 * Chamada pelo process-message.ts quando o bot recebe uma mensagem do cliente
 * via WhatsApp. A mensagem aparece no Chatwoot como "incoming".
 *
 * @param cfg     - Config geral do OpenClaw (precisa ter integrations.chatwoot)
 * @param phone   - Telefone do cliente em formato E.164 (ex: "5511999999999")
 * @param text    - Texto da mensagem recebida
 * @param senderName - Nome do remetente (pushName do WhatsApp), usado ao criar contato
 */
export function espelharMensagemEntrada(
  cfg: { integrations?: { chatwoot?: ChatwootConfig } },
  phone: string,
  text: string,
  senderName?: string,
): void {
  const cw = obterConfigChatwoot(cfg);
  if (!cw) return;

  // Sanitiza inputs antes de enviar ao Chatwoot (Danielle Gurgel, 2026-02-25)
  const nomeSafe = sanitizarNome(senderName);
  const textoSafe = sanitizarTexto(text);

  // Fire-and-forget — erros só vão pro log, nunca bloqueiam o bot
  void (async () => {
    try {
      const contactId = await buscarOuCriarContato(cw, phone, nomeSafe);
      const conversationId = await buscarOuCriarConversa(cw, contactId, phone);
      await requisicaoChatwoot(cw, `/conversations/${conversationId}/messages`, "POST", {
        content: textoSafe,
        message_type: "incoming",
        content_type: "text",
      });
    } catch (err) {
      // Correção item 10: log com stack para não perder detalhes do erro
      const detalheErro = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log.warn(
        `espelharMensagemEntrada falhou (${mascararTelefone(
          normalizarTelefoneE164(phone),
        )}): ${detalheErro}`,
      );
    }
  })();
}

/**
 * Espelha uma mensagem de SAÍDA (bot → cliente) no Chatwoot.
 *
 * Chamada em dois lugares:
 *   1. process-message.ts — quando o bot responde automaticamente (auto-reply)
 *   2. outbound.ts — quando o CRM/n8n envia mensagem via CLI (openclaw agent --deliver)
 *
 * A mensagem aparece no Chatwoot como "outgoing".
 *
 * @param cfg   - Config geral do OpenClaw (precisa ter integrations.chatwoot)
 * @param phone - Telefone do cliente em formato E.164 (ex: "5511999999999")
 * @param text  - Texto da mensagem enviada
 */
export function espelharMensagemSaida(
  cfg: { integrations?: { chatwoot?: ChatwootConfig } },
  phone: string,
  text: string,
): void {
  const cw = obterConfigChatwoot(cfg);
  if (!cw || !text) {
    return;
  }

  // Sanitiza texto antes de enviar ao Chatwoot (Danielle Gurgel, 2026-02-25)
  const textoSafe = sanitizarTexto(text);

  // Fire-and-forget — erros só vão pro log, nunca bloqueiam o bot
  void (async () => {
    try {
      const contactId = await buscarOuCriarContato(cw, phone);
      const conversationId = await buscarOuCriarConversa(cw, contactId, phone);
      await requisicaoChatwoot(cw, `/conversations/${conversationId}/messages`, "POST", {
        content: textoSafe,
        message_type: "outgoing",
        content_type: "text",
      });
    } catch (err) {
      // Correção item 10: log com stack para não perder detalhes do erro
      const detalheErro = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log.warn(
        `espelharMensagemSaida falhou (${mascararTelefone(
          normalizarTelefoneE164(phone),
        )}): ${detalheErro}`,
      );
    }
  })();
}

// =============================================================================
// Verificação HMAC-SHA256 para webhooks de handoff (Danielle Gurgel, 2026-02-25)
// Aceita header no formato "sha256=<hex>" (padrão Meta) ou "<hex>" puro (Chatwoot).
// O segredo é o hooks token do gateway — o mesmo que vai na URL do webhook.
// =============================================================================

/**
 * Verifica assinatura HMAC-SHA256 do webhook de handoff.
 * Deve ser chamada na camada HTTP (server-http.ts) com o rawBody ANTES do parse.
 */
export function verificarHmacHandoff(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  const expected = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  if (!expected || expected.length < 10) {
    return false;
  }
  const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(computed, "hex"));
  } catch {
    return false;
  }
}

/**
 * Helper definitivo (2026-02-25):
 * - Verifica HMAC com rawBody
 * - Só então faz JSON.parse
 * - E delega para processarEventoHandoffChatwoot(payload)
 *
 * Isso permite que o handler HTTP use uma única chamada aqui e não esqueça a ordem correta.
 */
export async function processarEventoHandoffChatwootAssinado(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): Promise<{ ok: true; action: string } | { ok: false; error: string }> {
  if (!verificarHmacHandoff(rawBody, signatureHeader, secret)) {
    return { ok: false, error: "assinatura inválida" };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "json inválido" };
  }

  return processarEventoHandoffChatwoot(payload);
}

// =============================================================================
// HANDOFF VIA CHATWOOT — controle do bot pelos botões Resolver/Reabrir
// =============================================================================
// Alteração: Daniele Gurgel, 2026-02-20
//
// Contexto de negócio:
//   Antes, o handoff (pausa do bot por número) só podia ser acionado pelo
//   WhatsApp via comando /handoff on|off. Agora o agente pode controlar
//   direto pelo painel do Chatwoot usando os botões nativos:
//     - "Reabrir"  → bot pausa (equivale a /handoff on +55... 1440)
//     - "Resolver" → bot volta (equivale a /handoff off +55...)
//
// Contexto técnico:
//   O Chatwoot envia um webhook com evento "conversation_status_changed"
//   quando o status de uma conversa muda. O gateway já tem o sistema de
//   hooks (POST /hooks/*) com autenticação e parsing de JSON prontos.
//   Esta função é chamada pelo subpath /hooks/handoff no cascade do
//   server-http.ts, recebe o payload já parseado e chama as mesmas
//   funções do handoff-store que o comando /handoff usa.
//
//   Duração: 1440 minutos (24h). Como o agente vai clicar "Resolver"
//   quando terminar, a duração longa é só uma segurança. Se esquecer,
//   expira em 24h automaticamente.
// =============================================================================

/**
 * Invalida o cache de conversa para um telefone.
 * Chamada quando o Chatwoot notifica que a conversa foi resolvida,
 * para que a próxima mensagem espelhada crie uma conversa nova.
 */
function invalidarCacheConversa(phone: string): void {
  const telefoneNormalizado = normalizarTelefoneE164(phone);
  cacheConversas.delete(telefoneNormalizado);
}

/** Duração do handoff acionado via Chatwoot (minutos). */
const HANDOFF_CHATWOOT_MINUTOS = 1440; // 24h — o Resolver despausa antes

/**
 * Processa um webhook do Chatwoot para controle de handoff.
 *
 * Mapeamento dos botões:
 *   "Resolver" (status "resolved") → activateHandoff  (bot pausa, humano assume)
 *   "Reabrir"  (status "open")     → deactivateHandoff (bot volta a responder)
 *
 * Recebe o payload já parseado pelo sistema de hooks do gateway.
 * Retorna { ok: true, action } se processou, { ok: false, error } se falhou.
 *
 * @param payload - Body JSON do webhook do Chatwoot (já parseado)
 */
export async function processarEventoHandoffChatwoot(
  payload: Record<string, unknown>,
): Promise<{ ok: true; action: string } | { ok: false; error: string }> {
  // -------------------------------------------------------------------------
  // Validação estrita do payload (Danielle Gurgel, 2026-02-25)
  // Garante que o payload tem a estrutura esperada de um webhook Chatwoot.
  // Rejeita payloads malformados para evitar que alguém abuse do endpoint.
  // -------------------------------------------------------------------------
  if (typeof payload.event !== "string" || !payload.event) {
    return { ok: false, error: "payload inválido: campo 'event' ausente ou não-string" };
  }

  const evento = payload.event;
  if (evento !== "conversation_status_changed") {
    // Outros eventos: aceita mas ignora (para o Chatwoot não reenviar)
    return { ok: true, action: "ignorado" };
  }

  // Valida que conversation existe e tem id numérico
  const conversa = payload.conversation as { id?: unknown } | undefined;
  if (!conversa || typeof conversa.id !== "number") {
    log.warn("Webhook handoff rejeitado: campo 'conversation.id' ausente ou não-numérico");
    return { ok: false, error: "payload inválido: conversation.id ausente" };
  }

  // --- Extrai e valida telefone do contato ---
  const contato = payload.contact as { phone_number?: string } | undefined;
  if (!contato || typeof contato.phone_number !== "string") {
    log.debug("Webhook handoff ignorado: contato sem phone_number");
    return { ok: true, action: "ignorado:sem-telefone" };
  }
  const telefone = contato.phone_number;

  const telefoneNorm = normalizarTelefoneE164(telefone);
  if (!telefoneValido(telefoneNorm)) {
    log.warn(
      `Webhook handoff rejeitado: telefone inválido (norm="${mascararTelefone(telefoneNorm)}")`,
    );
    return { ok: false, error: "telefone inválido" };
  }

  // --- Mapeia status → ação de handoff ---
  const status = payload.status as string | undefined;

  if (status === "resolved") {
    // "Resolver" → ativa handoff (bot pausa, humano assume o atendimento)
    const telefoneNormalizado = normalizarTelefoneE164(telefone);
    await activateHandoff(telefoneNormalizado, "chatwoot:resolver", HANDOFF_CHATWOOT_MINUTOS);
    invalidarCacheConversa(telefone);
    log.info(
      `Handoff ATIVADO via Chatwoot para ${mascararTelefone(
        telefoneNormalizado,
      )} (${HANDOFF_CHATWOOT_MINUTOS} min)`,
    );
    return { ok: true, action: "handoff-on" };
  }

  if (status === "open") {
    // "Reabrir" → desativa handoff (bot volta a responder)
    const telefoneNormalizado = normalizarTelefoneE164(telefone);
    await deactivateHandoff(telefoneNormalizado);
    log.info(`Handoff DESATIVADO via Chatwoot para ${mascararTelefone(telefoneNormalizado)}`);
    return { ok: true, action: "handoff-off" };
  }

  // "pending", "snoozed", etc → ignora
  log.debug(`Webhook handoff ignorado: status "${status}" não mapeado`);
  return { ok: true, action: `ignorado:${status}` };
}
