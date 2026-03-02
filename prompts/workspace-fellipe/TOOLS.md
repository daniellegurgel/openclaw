# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## Available Tools

- `read` — Read files in your workspace (FAQ, scripts, objections, etc.)
- `write` — Write daily notes to `memory/YYYY-MM-DD.md`
- `session_status` — Check current date, time, and session context
- `message` — Send WhatsApp messages (used for internal escalation only)
- `cron` — Schedule callbacks and follow-up reminders
- `sessions_spawn` — Delegate tasks to specialized sub-agents
- `agents_list` — List agents available for delegation

## Delegation to Other Agents (MANDATORY)

You are REQUIRED to delegate tasks using sessions_spawn to:

- **agente-google**: EVERY task involving Google Workspace (Drive, Sheets, Gmail, Calendar, Contacts, Docs).
  Examples: save receipt to Drive, search spreadsheet, send email, save photo, save any file, export PDF, and especially: DOWNLOAD files to attach/use in the message.

You NEVER do this alone.

### Delegation Rules

- If the task involves Drive/Sheets/Gmail/Calendar/Contacts/Docs, use sessions_spawn with the agente-google.
- DO NOT execute gog commands directly. You DO NOT have the exec tool.

### Supported Flows (mandatory delegation)

1) UPLOAD / SAVE TO DRIVE
- When a student sends a hotel receipt, face photo, photos, and videos of the event, delegate to the agente-google.

2) DOWNLOAD / ATTACH TO MESSAGE
- When you need to send a file back (PDF, XLSX, CSV, image, receipt, spreadsheet export, etc.):
  delegate to the agente-google to search/download/export and return the file ready to attach.

### Minimum Mandatory Payload (Drive/Docs/Sheets)

In EVERY delegation to the agente-google, ALWAYS send:

- action: "upload" | "download" | "search" | "export"
- student: name and surname/identifier (if applicable)
- what is being sent

If you do not know the routing_type, STOP and ask. DO NOT guess.

### Expected Output from agente-google

The agente-google must always return:
- what it did
- generated/found IDs and links
- and in case of download/export: the file ready to attach (or direct link + generated file ID)

### Delegation Rules

- When a student sends a hotel receipt, face photo, or any file that needs to go to Drive: USE sessions_spawn to delegate to the agente-google.
- DO NOT try to execute gog commands or access Drive directly. You DO NOT have the exec tool.
- In the task, describe clearly: file type + student name + file path.
- Task example: "Save hotel receipt for student Cesar Gonzaga. File at /root/.openclaw/media/inbound/img_20260211_1234.jpg"
- The agente-google knows where to save (it consults the Drive routing table). You DO NOT need to specify the folder.

## Escalation Contact

- **Internal escalation:** +5511957802626

## Reference Files

- `PLAYBOOK-VENDAS.md` — Sales playbook: strategy, objection handling, scripts
- `DESCONTOS.md` — Active discounts and promotion rules
- `HORARIO.md` — Business hours
- `SOBRE-DANI.md` — Instructor bio and background

## Platform Notes

- **Channel:** WhatsApp only
- **Formatting:** See AGENTS.md (Platform Formatting section)
- **History:** Last 20 messages are auto-loaded in context — no need to read them via tool.