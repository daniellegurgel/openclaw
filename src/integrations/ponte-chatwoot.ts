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
// Caches em memória (telefone normalizado → id do Chatwoot)
// Evita chamadas repetidas à API para o mesmo contato/conversa.
// A chave é SEMPRE o telefone normalizado via normalizarTelefoneE164().
// =============================================================================
const cacheContatos = new Map<string, number>();
const cacheConversas = new Map<string, number>();

// =============================================================================
// Funções internas (helpers)
// =============================================================================

/**
 * Normaliza um telefone para formato E.164 puro (só dígitos, sem +, sem @).
 * Essa função é CRÍTICA para evitar duplicação de contatos/conversas no cache.
 *
 * Exemplos:
 *   "+5511999999999"           → "5511999999999"
 *   "5511999999999"            → "5511999999999"
 *   "5511999999999@s.whatsapp.net" → "5511999999999"
 *   "55 11 99999-9999"         → "5511999999999"
 *
 * Correção do item 1 da revisão de código: sem essa normalização,
 * o mesmo telefone em formatos diferentes criava duplicatas no Chatwoot.
 */
function normalizarTelefoneE164(phone: string): string {
  // Remove sufixo de JID (@s.whatsapp.net, @c.us, etc)
  const semJid = phone.split("@")[0];
  // Remove tudo que não for dígito
  return semJid.replace(/\D/g, "");
}

/**
 * Obtém a configuração do Chatwoot a partir do config geral do OpenClaw.
 * Retorna null se a integração estiver desabilitada ou incompleta.
 */
function obterConfigChatwoot(
  cfg: { integrations?: { chatwoot?: ChatwootConfig } },
): ChatwootConfig | null {
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

/**
 * Busca um contato no Chatwoot pelo telefone. Se não encontrar, cria um novo.
 * Usa cache em memória para evitar buscas repetidas.
 *
 * Lógica de negócio: cada número de WhatsApp corresponde a um contato no
 * Chatwoot. O contato é associado ao inbox (canal API) configurado.
 */
async function buscarOuCriarContato(
  cw: ChatwootConfig,
  phone: string,
  name?: string,
): Promise<number> {
  // Correção item 1: normaliza telefone ANTES de usar como chave do cache.
  // Sem isso, "5511..." e "+5511..." criavam contatos duplicados.
  const telefoneNormalizado = normalizarTelefoneE164(phone);

  // Correção item 7: usar !== undefined em vez de if (cached),
  // porque id 0 (improvável mas possível) seria tratado como falsy.
  const cached = cacheContatos.get(telefoneNormalizado);
  if (cached !== undefined) return cached;

  // Tenta buscar contato existente pela busca textual do Chatwoot
  try {
    const resultado = (await requisicaoChatwoot(
      cw,
      `/contacts/search?q=${encodeURIComponent(telefoneNormalizado)}&include_contacts=true`,
      "GET",
    )) as {
      payload?: Array<{ id: number; phone_number?: string }>;
    };
    // Correção item 1: compara sempre com dígitos puros para evitar mismatch
    const encontrado = resultado.payload?.find((c) => {
      const telContato = c.phone_number?.replace(/\D/g, "") ?? "";
      return telContato === telefoneNormalizado;
    });
    if (encontrado) {
      cacheContatos.set(telefoneNormalizado, encontrado.id);
      return encontrado.id;
    }
  } catch {
    // Busca falhou — tenta criar
  }

  // Cria contato novo no Chatwoot (sempre com + na frente, padrão E.164)
  const contato = (await requisicaoChatwoot(cw, "/contacts", "POST", {
    inbox_id: cw.inboxId,
    name: name || `+${telefoneNormalizado}`,
    phone_number: `+${telefoneNormalizado}`,
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
    const convs = (await requisicaoChatwoot(
      cw,
      `/contacts/${contactId}/conversations`,
      "GET",
    )) as { payload?: Array<{ id: number; inbox_id: number; status: string }> };
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

  // Fire-and-forget — erros só vão pro log, nunca bloqueiam o bot
  void (async () => {
    try {
      const contactId = await buscarOuCriarContato(cw, phone, senderName);
      const conversationId = await buscarOuCriarConversa(cw, contactId, phone);
      await requisicaoChatwoot(cw, `/conversations/${conversationId}/messages`, "POST", {
        content: text,
        message_type: "incoming",
        content_type: "text",
      });
    } catch (err) {
      // Correção item 10: log com stack para não perder detalhes do erro
      const detalheErro = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log.warn(`espelharMensagemEntrada falhou (${phone}): ${detalheErro}`);
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
  if (!cw || !text) return;

  // Fire-and-forget — erros só vão pro log, nunca bloqueiam o bot
  void (async () => {
    try {
      const contactId = await buscarOuCriarContato(cw, phone);
      const conversationId = await buscarOuCriarConversa(cw, contactId, phone);
      await requisicaoChatwoot(cw, `/conversations/${conversationId}/messages`, "POST", {
        content: text,
        message_type: "outgoing",
        content_type: "text",
      });
    } catch (err) {
      // Correção item 10: log com stack para não perder detalhes do erro
      const detalheErro = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log.warn(`espelharMensagemSaida falhou (${phone}): ${detalheErro}`);
    }
  })();
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
  // --- Valida evento ---
  const evento = payload.event;
  if (evento !== "conversation_status_changed") {
    // Outros eventos: aceita mas ignora (para o Chatwoot não reenviar)
    return { ok: true, action: "ignorado" };
  }

  // --- Extrai telefone do contato ---
  const contato = payload.contact as { phone_number?: string } | undefined;
  const telefone = contato?.phone_number;
  if (!telefone) {
    log.debug("Webhook handoff ignorado: contato sem phone_number");
    return { ok: true, action: "ignorado:sem-telefone" };
  }

  // --- Mapeia status → ação de handoff ---
  const status = payload.status as string | undefined;

  if (status === "resolved") {
    // "Resolver" → ativa handoff (bot pausa, humano assume o atendimento)
    const telefoneNormalizado = normalizarTelefoneE164(telefone);
    await activateHandoff(telefoneNormalizado, "chatwoot:resolver", HANDOFF_CHATWOOT_MINUTOS);
    invalidarCacheConversa(telefone);
    log.info(`Handoff ATIVADO via Chatwoot para ${telefoneNormalizado} (${HANDOFF_CHATWOOT_MINUTOS} min)`);
    return { ok: true, action: "handoff-on" };
  }

  if (status === "open") {
    // "Reabrir" → desativa handoff (bot volta a responder)
    const telefoneNormalizado = normalizarTelefoneE164(telefone);
    await deactivateHandoff(telefoneNormalizado);
    log.info(`Handoff DESATIVADO via Chatwoot para ${telefoneNormalizado}`);
    return { ok: true, action: "handoff-off" };
  }

  // "pending", "snoozed", etc → ignora
  log.debug(`Webhook handoff ignorado: status "${status}" não mapeado`);
  return { ok: true, action: `ignorado:${status}` };
}
