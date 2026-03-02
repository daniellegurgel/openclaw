#!/usr/bin/env python3
"""
Cruza os 34 telefones do Chatwoot sem nome com TODOS os leads do EspoCRM.
Exporta todos os telefones do CRM e faz match local (evita N queries).

Danielle Gurgel, 2026-02-25
"""
import subprocess, json, urllib.parse, re

AUTH = "admin:Usp@19782026"
BASE = "https://crm.neurotrading.com.br/api/v1"
CW_TOKEN = "5gW1D4xtWRVauCPGvHs9fPVr"
CW_BASE = "http://localhost:3000/api/v1/accounts/1"

phone_re = re.compile(r"^\+?\d[\d\s\-()]+$")


def normalizar(phone):
    return re.sub(r"\D", "", phone or "")


# 1. Exportar TODOS os leads do CRM com telefone
print("Exportando todos os leads do CRM...")
all_leads = []
offset = 0
while True:
    params = urllib.parse.urlencode({
        "where[0][type]": "isNotNull",
        "where[0][attribute]": "phoneNumber",
        "select": "firstName,lastName,phoneNumber",
        "maxSize": "200",
        "offset": str(offset),
    })
    url = BASE + "/Lead?" + params
    r = subprocess.run(["curl", "-s", "-u", AUTH, url], capture_output=True, text=True)
    data = json.loads(r.stdout)
    batch = data.get("list", [])
    if not batch:
        break
    all_leads.extend(batch)
    offset += len(batch)
    if offset >= data.get("total", 0):
        break

print(f"  {len(all_leads)} leads com telefone no CRM")

# Indexar por últimos 8, 9, 10, 11 dígitos
crm_by_digits = {}  # digits -> (name, phoneNumber)
for lead in all_leads:
    fn = (lead.get("firstName") or "").strip()
    ln = (lead.get("lastName") or "").strip()
    name = f"{fn} {ln}".strip()
    phone = normalizar(lead.get("phoneNumber", ""))
    if phone and name:
        # Indexar por vários sufixos
        for n in [8, 9, 10, 11, 12, 13]:
            if len(phone) >= n:
                suffix = phone[-n:]
                if suffix not in crm_by_digits:
                    crm_by_digits[suffix] = (name, lead.get("phoneNumber", ""))

print(f"  {len(crm_by_digits)} chaves de busca indexadas")

# 2. Carregar contatos Chatwoot sem nome
print("\nCarregando contatos do Chatwoot...")
todos_cw = []
page = 1
while True:
    r = subprocess.run(
        ["curl", "-s", "-H", f"api_access_token: {CW_TOKEN}",
         f"{CW_BASE}/contacts?page={page}"],
        capture_output=True, text=True
    )
    data = json.loads(r.stdout) if r.stdout.strip() else {}
    payload = data.get("payload", [])
    if not payload:
        break
    todos_cw.extend(payload)
    page += 1
    if page > 100:
        break

sem_nome = []
for c in todos_cw:
    name = (c.get("name") or "").strip()
    phone = (c.get("phone_number") or "").strip()
    if phone and (not name or phone_re.match(name)):
        sem_nome.append(c)

print(f"  {len(sem_nome)} contatos sem nome real")

# 3. Cruzar
print(f"\nCruzando...")
encontrados = []
nao_encontrados = []

for c in sem_nome:
    cw_phone = normalizar(c.get("phone_number", ""))
    cw_id = c["id"]
    found = False

    # Tentar match por sufixos decrescentes
    for n in [13, 12, 11, 10, 9, 8]:
        if len(cw_phone) >= n:
            suffix = cw_phone[-n:]
            if suffix in crm_by_digits:
                crm_name, crm_phone = crm_by_digits[suffix]
                encontrados.append({
                    "cw_id": cw_id,
                    "cw_phone": c.get("phone_number", ""),
                    "crm_name": crm_name,
                    "crm_phone": crm_phone,
                    "match": f"last{n}",
                })
                found = True
                break

    if not found:
        nao_encontrados.append({
            "cw_id": cw_id,
            "cw_phone": c.get("phone_number", ""),
        })

# 4. Relatório
print(f"\n{'='*70}")
print(f"ENCONTRADOS ({len(encontrados)}):")
print(f"{'='*70}")
for item in encontrados:
    print(f"  id={item['cw_id']}  CW={item['cw_phone']}  ->  CRM: {item['crm_name']} ({item['crm_phone']})  [{item['match']}]")

print(f"\nNAO ENCONTRADOS ({len(nao_encontrados)}):")
for item in nao_encontrados:
    print(f"  id={item['cw_id']}  {item['cw_phone']}")

print(f"\n--- RESUMO ---")
print(f"  Encontrados: {len(encontrados)}")
print(f"  Nao encontrados: {len(nao_encontrados)}")
