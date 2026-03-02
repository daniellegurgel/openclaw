#!/usr/bin/env python3
"""Verifica duplicatas e relação entre contatos sem nome e envio de mensagens."""
import json, subprocess, re
from collections import defaultdict

CHATWOOT_TOKEN = "5gW1D4xtWRVauCPGvHs9fPVr"
phone_pattern = re.compile(r"^\+?\d[\d\s\-()]+$")

# Carregar todos os contatos
todos = []
page = 1
while True:
    r = subprocess.run(["curl", "-s", "-H", f"api_access_token: {CHATWOOT_TOKEN}",
        f"http://localhost:3000/api/v1/accounts/1/contacts?page={page}"],
        capture_output=True, text=True)
    try:
        data = json.loads(r.stdout)
    except:
        break
    payload = data.get("payload", [])
    if not payload:
        break
    todos.extend(payload)
    page += 1
    if page > 100:
        break

print(f"Total contatos: {len(todos)}")

# Agrupar por telefone
por_telefone = defaultdict(list)
for c in todos:
    phone = (c.get("phone_number") or "").strip()
    if phone:
        por_telefone[phone].append(c)

# Duplicatas
duplicatas = {ph: cs for ph, cs in por_telefone.items() if len(cs) > 1}
print(f"Telefones duplicados: {len(duplicatas)}")
for phone, contacts in sorted(duplicatas.items()):
    print(f"\n  {phone}:")
    for c in contacts:
        cid = c["id"]
        name = c.get("name", "")
        created = str(c.get("created_at", ""))[:10]
        print(f"    id={cid}  name=\"{name}\"  created={created}")

# Sem nome: verificar se tem conversations
print("\n\n=== CONTATOS SEM NOME — TEM CONVERSA? ===")
sem_nome_com_conversa = 0
sem_nome_sem_conversa = 0
for c in todos:
    name = (c.get("name") or "").strip()
    phone = (c.get("phone_number") or "").strip()
    if not name or phone_pattern.match(name):
        # Buscar conversas deste contato
        cid = c["id"]
        r2 = subprocess.run(["curl", "-s", "-H", f"api_access_token: {CHATWOOT_TOKEN}",
            f"http://localhost:3000/api/v1/accounts/1/contacts/{cid}/conversations"],
            capture_output=True, text=True)
        try:
            conv_data = json.loads(r2.stdout)
            convs = conv_data.get("payload", [])
            n_convs = len(convs)
        except:
            n_convs = -1

        status = "COM CONVERSA" if n_convs > 0 else "sem conversa"
        if n_convs > 0:
            sem_nome_com_conversa += 1
            # Pegar info da conversa
            first_conv = convs[0] if convs else {}
            inbox = first_conv.get("inbox_id", "?")
            created = str(first_conv.get("created_at", ""))[:10]
            print(f"  id={cid}  {phone}  {status} (inbox={inbox}, conv_created={created})")
        else:
            sem_nome_sem_conversa += 1
            print(f"  id={cid}  {phone}  {status}")

print(f"\n--- RESUMO ---")
print(f"Sem nome COM conversa: {sem_nome_com_conversa}")
print(f"Sem nome SEM conversa: {sem_nome_sem_conversa}")
