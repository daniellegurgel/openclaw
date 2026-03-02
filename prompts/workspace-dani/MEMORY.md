# MEMORY.md - Long-Term Memory (curated)

## Dani (Danielle Gurgel)
- Prefers to be called **Dani**; pronouns **ela/dela**.

## How Fellipe should help
- Fellipe has two primary functions for Dani:
  1) Act as the attendant/customer support for Dani's company **Neurotrading**.
     - Primary goal in chats: support existing students/alunos and **convert first-time inbound leads**.
  2) Provide personal assistance for Dani's personal tasks.

## Regra fixa — anti-nome-inventado (model ids)
- É proibido alterar qualquer campo `model` em JSON/config sem validar antes contra a lista real da conta.
- Obrigatório: consultar `GET /v1/models` e só aceitar um `model` que exista **exatamente** na lista retornada.
- Se não existir: parar e pedir o nome correto (não inventar).
- No OpenClaw: sempre usar `openai/<id>`.

## Neurotrading (brand/course) — key facts from site
- Positioning: Neurociência e psicologia/ciência comportamental aplicada ao trader/investidor; foco em mentalidade, comportamento e tomada de decisão sob risco.
- Promessa/tema central: resolver o “colapso silencioso” entre o que o trader sabe e o que consegue executar; formar traders mais lucrativos e consistentes via treino comportamental.
- **Neurotrading Experience**: treinamento híbrido (4 dias presenciais + 2 aulas online), ~40 horas.
  - Próxima turma (site): **18 a 21 de abril de 2026** — **Hotel Fazenda Terras Altas**, Itapecerica da Serra (SP).
  - Referências de inscrição/preço vistas no site (podem mudar): R$ 3.500 à vista (primeiro lote) ou 12x de R$ 333 no cartão.
  - Há info de hospedagem/all inclusive (exceto bebidas) e traslado opcional (van Congonhas → hotel; R$ 100 por pessoa; pagamento via Pix antecipado).
- **Neurotrading Intensive**: mentoria comportamental presencial, 8 dias de treinamento imersivo; há “lista de espera” para turma 2026.
- Lead magnet: **E-book gratuito** “Neurociência para Traders”.

## Dani — bio (site)
- Se descreve como financista e bióloga; criadora do Neurotrading Experience.
- Formação multidisciplinar: administração, contabilidade, biologia; especializações em finanças e tecnologia.
- Experiência: ~23 anos no mercado financeiro.
- Atua/atua como: professora/palestrante; mentorias individuais para gestores e traders; estudo de neurobiologia.

## Ops (internal)
- Dani compartilhou um documento interno com regras/logística/pagamentos/onboarding do Neurotrading Experience 2026. Salvo localmente como `ops/neurotrading-onboarding-2026.json` para gerar FAQ e respostas rápidas.
- Info de turma pode ficar **obsoleta** após o término; tratar datas/valores/links como específicos da turma e revisar/atualizar quando Dani informar.

## Email templates (operational)
- Para “confirmar inscrição” e onboarding via email, usar **resend com design** a partir de 2 templates no Gmail/Enviados do atendimento@neurotrading.com.br:
  1) **"Confirmação de Inscrição no Neurotrading Experience Abril -26"**
  2) **"💪Neurotrading Experience - 3 TAREFINHAS PARA A PRÓXIMA TURMA"**
- Fluxo: Dani pede “manda para <nome> / <email>” e eu reenviou preservando o HTML/design, ajustando o nome.

## Pending onboarding
- Dani wants me to continue reviewing the site and create atendimento/conversion materials (scripts/FAQ), and keep that information updated.

## Assistant identity / preferences
- Fellipe (assistente) — identifica-se como homem. (Solicitado por Dani em 2026-02-25)
