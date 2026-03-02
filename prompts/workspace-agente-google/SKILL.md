---
name: gog
description: Google Workspace CLI para Gmail, Calendar, Drive, Contacts, Sheets, Docs e Slides.
homepage: https://gogcli.sh
metadata:
  {
    "openclaw":
      {
        "emoji": "🎮",
        "requires": { "bins": ["gog"] },
      },
  }
---

# gog

CLI unificado para Google Workspace. Sempre use --account atendimento@neurotrading.com.br

## Drive

```bash
# Buscar arquivos
gog drive search "nome do arquivo" --max 10 --json

# Upload de arquivo
gog drive upload ./arquivo.pdf --parent <folderId>

# Upload com nome customizado
gog drive upload ./arquivo.pdf --parent <folderId> --name "nome-customizado.pdf"

# Download
gog drive download <fileId> --out ./arquivo.pdf

# Criar pasta
gog drive mkdir "Nome da Pasta" --parent <folderId>

# Listar conteudo de pasta
gog drive list <folderId> --max 50 --json

# Compartilhar
gog drive share <fileId> --email user@email.com --role reader
```

## Sheets

```bash
# Ler celulas
gog sheets get <sheetId> "NomeAba!A1:D10" --json

# Escrever celulas
gog sheets update <sheetId> "NomeAba!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED

# Adicionar linha (append)
gog sheets append <sheetId> "NomeAba!A:E" --values-json '[["v1","v2","v3","v4","v5"]]' --insert INSERT_ROWS

# Limpar range
gog sheets clear <sheetId> "NomeAba!A2:Z"

# Metadata (nomes de abas, estrutura)
gog sheets metadata <sheetId> --json

# Exportar
gog sheets export <sheetId> --format pdf --out ./planilha.pdf
```

## Gmail

```bash
# Buscar threads
gog gmail search 'newer_than:7d' --max 10

# Buscar mensagens individuais
gog gmail messages search "in:inbox from:email@example.com" --max 20

# Enviar (texto)
gog gmail send --to dest@email.com --subject "Assunto" --body "Texto"

# Enviar (multi-linha via stdin)
gog gmail send --to dest@email.com --subject "Assunto" --body-file - <<'EOF'
Primeira linha.

Segunda linha.

Atenciosamente,
Neurotrading
EOF

# Enviar (HTML)
gog gmail send --to dest@email.com --subject "Assunto" --body-html "<p>Texto</p>"

# Responder
gog gmail send --to dest@email.com --subject "Re: Assunto" --body "Resposta" --reply-to-message-id <msgId>

# Rascunho
gog gmail drafts create --to dest@email.com --subject "Assunto" --body-file ./msg.txt
```

## Calendar

```bash
# Listar eventos
gog calendar events primary --from 2026-04-18T00:00:00Z --to 2026-04-21T23:59:59Z

# Criar evento
gog calendar create primary --summary "Titulo" --from <iso> --to <iso>

# Atualizar evento
gog calendar update primary <eventId> --summary "Novo Titulo"

# Cores (IDs 1-11): 1=azul claro, 2=verde, 3=roxo, 4=vermelho, 5=amarelo, 6=laranja, 7=turquesa, 8=cinza, 9=azul escuro, 10=verde escuro, 11=vermelho escuro
```

## Contacts

```bash
# Buscar
gog contacts search "Nome" --max 10

# Listar
gog contacts list --max 20
```

## Docs

```bash
# Exportar
gog docs export <docId> --format txt --out /tmp/doc.txt
gog docs export <docId> --format pdf --out /tmp/doc.pdf

# Ler conteudo
gog docs cat <docId>
```

## Notas

- Sempre use --json pra output processavel
- Use --no-input pra evitar prompts interativos
- Sheets: --input USER_ENTERED permite formulas e formatacao automatica
- Drive upload sem --parent sobe pra raiz do Drive
