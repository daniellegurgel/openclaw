#!/usr/bin/env python3
"""
Varre TODOS os contatos do Chatwoot, identifica os sem nome real,
e cruza com EspoCRM para mostrar quem pode ser corrigido.
Danielle Gurgel, 2026-02-25
"""
import json, subprocess, re

CHATWOOT_TOKEN = "5gW1D4xtWRVauCPGvHs9fPVr"
ESPO_AUTH = "admin:Usp@19782026"

phone_pattern = re.compile(r"^\+?\d[\d\s\-()]+$")


def carregar_todos_contatos_chatwoot():
    todos = []
    page = 1
    while True:
        r = subprocess.run(
            ["curl", "-s", "-H", f"api_access_token: {CHATWOOT_TOKEN}",
             f"http://localhost:3000/api/v1/accounts/1/contacts?page={page}"],
            capture_output=True, text=True
        )
        try:
            data = json.loads(r.stdout)
        except json.JSONDecodeError:
            break
        payload = data.get("payload", [])
        if not payload:
            break
        todos.extend(payload)
        page += 1
        if page > 100:
            break
    return todos


def sem_nome_real(contact):
    name = (contact.get("name") or "").strip()
    if not name:
        return True
    if phone_pattern.match(name):
        return True
    return False


def buscar_nome_espo(phone):
    if not phone:
        return None
    search = phone.lstrip("+")
    for entity in ["Lead", "Contact"]:
        url = (
            f"https://crm.neurotrading.com.br/api/v1/{entity}"
            f"?where[0][type]=contains&where[0][attribute]=phoneNumber"
            f"&where[0][value]={search}&select=firstName,lastName,phoneNumber&maxSize=5"
        )
        r = subprocess.run(
            ["curl", "-s", "-u", ESPO_AUTH, url],
            capture_output=True, text=True
        )
        try:
            data = json.loads(r.stdout)
        except json.JSONDecodeError:
            continue
        for item in data.get("list", []):
            first = (item.get("firstName") or "").strip()
            last = (item.get("lastName") or "").strip()
            name = f"{first} {last}".strip()
            if name:
                return name
    return None


# === APENAS LEVANTAMENTO ===
print("Carregando todos os contatos do Chatwoot...")
todos = carregar_todos_contatos_chatwoot()
print(f"Total: {len(todos)} contatos\n")

sem_nome = [c for c in todos if sem_nome_real(c)]
print(f"Sem nome real: {len(sem_nome)}\n")

if not sem_nome:
    print("Todos os contatos ja tem nome!")
    exit(0)

corrigivel = []
sem_telefone = []
nao_no_crm = []

for c in sem_nome:
    cw_id = c["id"]
    phone = (c.get("phone_number") or "").strip()
    current_name = (c.get("name") or "").strip()

    if not phone:
        sem_telefone.append(c)
        continue

    nome_crm = buscar_nome_espo(phone)
    if nome_crm:
        corrigivel.append((cw_id, phone, current_name, nome_crm))
    else:
        nao_no_crm.append((cw_id, phone, current_name))

print("=" * 70)
print(f"CORRIGIVEIS ({len(corrigivel)}) — tem nome no CRM, falta no Chatwoot:")
print("=" * 70)
for cw_id, phone, old, new in corrigivel:
    print(f"  id={cw_id}  {phone}  chatwoot=\"{old}\"  ->  CRM=\"{new}\"")

print()
print(f"NAO ENCONTRADOS NO CRM ({len(nao_no_crm)}):")
for cw_id, phone, old in nao_no_crm:
    print(f"  id={cw_id}  {phone}  chatwoot=\"{old}\"")

if sem_telefone:
    print()
    print(f"SEM TELEFONE ({len(sem_telefone)}):")
    for c in sem_telefone:
        print(f"  id={c['id']}  name=\"{c.get('name','')}\"  email={c.get('email','')}")

print()
print("--- RESUMO ---")
print(f"Total sem nome:         {len(sem_nome)}")
print(f"Corrigiveis (CRM ok):   {len(corrigivel)}")
print(f"Nao encontrados no CRM: {len(nao_no_crm)}")
print(f"Sem telefone:           {len(sem_telefone)}")
