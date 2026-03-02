#!/usr/bin/env python3
"""Torna o campo agent dinâmico no n8n.
- Extrair dados da Task: extrai cAgente
- Preparar chamada: passa agente no output
- Chamar OpenClaw: usa $json.agent
Danielle Gurgel, 2026-02-25
"""
import json
import urllib.request
import urllib.error

API_KEY = "n8n_api_a553dd31fa1847ea8abc931729c8dca1"
BASE = "http://localhost:5678/api/v1"
WF_ID = "3a79a37d9b944d2782b26"

req = urllib.request.Request(
    BASE + "/workflows/" + WF_ID,
    headers={"X-N8N-API-KEY": API_KEY}
)
with urllib.request.urlopen(req) as resp:
    wf = json.loads(resp.read())

for node in wf["nodes"]:

    # === Extrair dados da Task: adicionar cAgente ===
    if "Extrair" in node.get("name", ""):
        js = node["parameters"]["jsCode"]

        # Adicionar agente ao single object
        if "cAgente" not in js:
            # No bloco single: adicionar após canal
            js = js.replace(
                'const canal = body.cCanal || "WhatsApp";',
                'const canal = body.cCanal || "WhatsApp";\nconst agente = body.cAgente || "fellipe";'
            )
            # No return single: adicionar agente
            js = js.replace(
                '        canal,\n        modoDisparo,',
                '        canal,\n        agente,\n        modoDisparo,'
            )
            # No bloco array: adicionar agente
            js = js.replace(
                'canal: t.cCanal || "WhatsApp",',
                'canal: t.cCanal || "WhatsApp",\n                agente: t.cAgente || "fellipe",'
            )
            node["parameters"]["jsCode"] = js
            print("Extrair dados: cAgente adicionado")

    # === Preparar chamada: passar agente no output ===
    if "Preparar" in node.get("name", ""):
        js = node["parameters"]["jsCode"]

        if "agente" not in js or "data.agente" not in js:
            # Adicionar leitura do agente após leadId
            js = js.replace(
                '    const leadId = data.leadId || "";',
                '    const leadId = data.leadId || "";\n    const agente = data.agente || "fellipe";'
            )
            # Adicionar agente no results.push
            js = js.replace(
                'results.push({ json: { phone, message, mode, channel, canal, firstName, taskId, taskName, leadId } });',
                'results.push({ json: { phone, message, mode, channel, canal, agente, firstName, taskId, taskName, leadId } });'
            )
            node["parameters"]["jsCode"] = js
            print("Preparar chamada: agente adicionado")

    # === Chamar OpenClaw: usar $json.agent dinâmico ===
    if "Chamar" in node.get("name", ""):
        new_body = '={{ JSON.stringify({ message: $json.message, to: $json.phone, channel: $json.channel, deliver: true, agent: $json.agente, sessionKey: $json.channel + ":dm:" + $json.phone }) }}'
        old_body = node["parameters"].get("jsonBody", "")
        node["parameters"]["jsonBody"] = new_body
        print("Chamar OpenClaw: agent dinamico")
        print("  old:", old_body[:200])
        print("  new:", new_body[:200])

payload = {
    "name": wf["name"],
    "nodes": wf["nodes"],
    "connections": wf["connections"],
    "settings": wf.get("settings", {}),
}

data = json.dumps(payload).encode("utf-8")
req = urllib.request.Request(
    BASE + "/workflows/" + WF_ID,
    data=data,
    headers={
        "X-N8N-API-KEY": API_KEY,
        "Content-Type": "application/json"
    },
    method="PUT"
)
try:
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
        print("OK - updatedAt:", result.get("updatedAt", "?"))
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print("ERRO", e.code, body[:300])
