#!/usr/bin/env python3
"""
Corrige contatos duplicados e sem nome no Chatwoot.
Cruza com EspoCRM (Lead) para encontrar nomes reais.

Danielle Gurgel, 2026-02-25

Uso:
  python3 tmp_fix_37_contatos.py          # dry-run
  python3 tmp_fix_37_contatos.py --apply  # aplica
"""
import json, subprocess, re, sys, urllib.parse
from collections import defaultdict

CHATWOOT_TOKEN = "5gW1D4xtWRVauCPGvHs9fPVr"
CHATWOOT_BASE = "http://localhost:3000/api/v1/accounts/1"
ESPO_AUTH = "admin:Usp@19782026"
ESPO_BASE = "https://crm.neurotrading.com.br/api/v1"

phone_pattern = re.compile(r"^\+?\d[\d\s\-()]+$")
apply_mode = "--apply" in sys.argv


def cw_get(path):
    r = subprocess.run(
        ["curl", "-s", "-H", f"api_access_token: {CHATWOOT_TOKEN}",
         f"{CHATWOOT_BASE}{path}"],
        capture_output=True, text=True
    )
    return json.loads(r.stdout) if r.stdout.strip() else {}


def cw_put(path, data):
    r = subprocess.run(
        ["curl", "-s", "-X", "PUT",
         "-H", f"api_access_token: {CHATWOOT_TOKEN}",
         "-H", "Content-Type: application/json",
         "-d", json.dumps(data),
         f"{CHATWOOT_BASE}{path}"],
        capture_output=True, text=True
    )
    return json.loads(r.stdout) if r.stdout.strip() else {}


def cw_delete(path):
    r = subprocess.run(
        ["curl", "-s", "-X", "DELETE",
         "-H", f"api_access_token: {CHATWOOT_TOKEN}",
         f"{CHATWOOT_BASE}{path}"],
        capture_output=True, text=True
    )
    return r.returncode == 0


def espo_buscar_nome(phone):
    """Busca nome no EspoCRM por telefone (Lead + Contact).
    IMPORTANTE: usa urllib.parse.urlencode para encoding correto dos colchetes."""
    digits = re.sub(r"\D", "", phone)
    if not digits:
        return None

    for entity in ["Lead", "Contact"]:
        params = urllib.parse.urlencode({
            "where[0][type]": "contains",
            "where[0][attribute]": "phoneNumber",
            "where[0][value]": digits,
            "select": "firstName,lastName,phoneNumber",
            "maxSize": "5",
        })
        url = f"{ESPO_BASE}/{entity}?{params}"
        r = subprocess.run(
            ["curl", "-s", "-u", ESPO_AUTH, url],
            capture_output=True, text=True
        )
        try:
            data = json.loads(r.stdout)
        except (json.JSONDecodeError, ValueError):
            continue
        for item in data.get("list", []):
            first = (item.get("firstName") or "").strip()
            last = (item.get("lastName") or "").strip()
            name = f"{first} {last}".strip()
            if name:
                return name
    return None


def normalizar(phone):
    return re.sub(r"\D", "", phone)


def tem_nome_real(contact):
    name = (contact.get("name") or "").strip()
    if not name:
        return False
    if phone_pattern.match(name):
        return False
    return True


# === 1. Carregar todos os contatos ===
print("Carregando contatos do Chatwoot...")
todos = []
page = 1
while True:
    data = cw_get(f"/contacts?page={page}")
    payload = data.get("payload", [])
    if not payload:
        break
    todos.extend(payload)
    page += 1
    if page > 100:
        break

print(f"Total: {len(todos)} contatos\n")

# === 2. Agrupar por telefone normalizado ===
por_telefone = defaultdict(list)
for c in todos:
    phone = (c.get("phone_number") or "").strip()
    if phone:
        norm = normalizar(phone)
        if norm:
            por_telefone[norm].append(c)

duplicatas = {ph: cs for ph, cs in por_telefone.items() if len(cs) > 1}
print(f"Telefones com duplicata: {len(duplicatas)}")

# === 3. Analisar duplicatas ===
acoes_merge = []
for phone, contacts in sorted(duplicatas.items()):
    com_nome = [c for c in contacts if tem_nome_real(c)]
    sem_nome = [c for c in contacts if not tem_nome_real(c)]
    if com_nome:
        manter = sorted(com_nome, key=lambda c: c["id"])[0]
        apagar = [c for c in contacts if c["id"] != manter["id"]]
    else:
        ordenados = sorted(contacts, key=lambda c: c["id"])
        manter = ordenados[0]
        apagar = ordenados[1:]
    for dup in apagar:
        acoes_merge.append({
            "phone": phone,
            "manter_id": manter["id"],
            "manter_nome": (manter.get("name") or ""),
            "apagar_id": dup["id"],
            "apagar_nome": (dup.get("name") or ""),
        })

# === 4. Contatos sem nome e sem duplicata — cruzar com CRM ===
sem_nome_solo = []
for c in todos:
    if tem_nome_real(c):
        continue
    phone = (c.get("phone_number") or "").strip()
    if not phone:
        continue
    norm = normalizar(phone)
    if norm not in duplicatas:
        sem_nome_solo.append(c)

renomear = []
nao_encontrado = []
print(f"\nBuscando {len(sem_nome_solo)} telefones no EspoCRM...")
for i, c in enumerate(sem_nome_solo, 1):
    phone = c.get("phone_number", "")
    nome_crm = espo_buscar_nome(phone)
    status = f"[{i}/{len(sem_nome_solo)}]"
    if nome_crm:
        renomear.append({"id": c["id"], "phone": phone, "old": c.get("name", ""), "new": nome_crm})
        print(f"  {status} {phone} -> {nome_crm}")
    else:
        nao_encontrado.append({"id": c["id"], "phone": phone, "old": c.get("name", "")})
        print(f"  {status} {phone} -> (nao encontrado)")

# === 5. Relatório ===
print("\n" + "=" * 70)
if acoes_merge:
    print(f"DUPLICATAS A APAGAR ({len(acoes_merge)}):")
    print("=" * 70)
    for a in acoes_merge:
        print(f"  +{a['phone']}:")
        print(f"    MANTER  id={a['manter_id']}  \"{a['manter_nome']}\"")
        print(f"    APAGAR  id={a['apagar_id']}  \"{a['apagar_nome']}\"")

if renomear:
    print(f"\nRENOMEAR VIA CRM ({len(renomear)}):")
    for item in renomear:
        print(f"  id={item['id']}  {item['phone']}  \"{item['old']}\" -> \"{item['new']}\"")

if nao_encontrado:
    print(f"\nSEM NOME NO CRM ({len(nao_encontrado)}):")
    for item in nao_encontrado:
        print(f"  id={item['id']}  {item['phone']}  \"{item['old']}\"")

total_acoes = len(acoes_merge) + len(renomear)
print(f"\n--- RESUMO ---")
print(f"Duplicatas a apagar: {len(acoes_merge)}")
print(f"Renomear via CRM:    {len(renomear)}")
print(f"Sem solucao:         {len(nao_encontrado)}")
print(f"Total acoes:         {total_acoes}")

if total_acoes == 0:
    print("\nNada a fazer!")
    sys.exit(0)

if not apply_mode:
    print(f"\n--- DRY RUN --- rode com --apply para executar")
    sys.exit(0)

# === 6. Aplicar ===
print(f"\n--- APLICANDO ---")
ok_del = err_del = ok_ren = err_ren = 0

for a in acoes_merge:
    try:
        cw_delete(f"/contacts/{a['apagar_id']}")
        print(f"  OK APAGADO id={a['apagar_id']}  +{a['phone']}")
        ok_del += 1
    except Exception as e:
        print(f"  ERRO apagando id={a['apagar_id']}: {e}")
        err_del += 1

for item in renomear:
    try:
        cw_put(f"/contacts/{item['id']}", {"name": item["new"]})
        print(f"  OK RENOMEADO id={item['id']}  {item['phone']}  -> \"{item['new']}\"")
        ok_ren += 1
    except Exception as e:
        print(f"  ERRO renomeando id={item['id']}: {e}")
        err_ren += 1

print(f"\nResultado: {ok_del} apagados, {ok_ren} renomeados, {err_del + err_ren} erros")
