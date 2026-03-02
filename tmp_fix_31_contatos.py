#!/usr/bin/env python3
"""
Corrige os 31 contatos duplicados do Chatwoot: contatos com JID (sem 9° dígito)
que têm um par E.164 (com 9° dígito) já existente.

Estratégia:
  1. Carrega TODOS contatos do Chatwoot
  2. Identifica contatos sem nome (JID format, 12 dígitos BR)
  3. Para cada JID, procura o par E.164 (com 9° dígito) no Chatwoot
  4. Se existe par E.164 → merge (JID é absorvido pelo E.164, conversas preservadas)
  5. Se não existe par → só renomeia (busca nome no CRM)

Danielle Gurgel, 2026-02-25

Uso:
  python3 tmp_fix_31_contatos.py          # dry-run
  python3 tmp_fix_31_contatos.py --apply  # aplica
"""
import subprocess, json, urllib.parse, re, sys

AUTH = "admin:Usp@19782026"
BASE = "https://crm.neurotrading.com.br/api/v1"
CW_TOKEN = "5gW1D4xtWRVauCPGvHs9fPVr"
CW_BASE = "http://localhost:3000/api/v1/accounts/1"

phone_re = re.compile(r"^\+?\d[\d\s\-()]+$")
apply_mode = "--apply" in sys.argv


def normalizar(phone):
    return re.sub(r"\D", "", phone or "")


def normalizar_e164(digits):
    """Adiciona 9° dígito se for celular BR com 12 dígitos."""
    if len(digits) == 12 and digits.startswith("55"):
        return digits[:4] + "9" + digits[4:]
    return digits


def cw_get(path):
    r = subprocess.run(
        ["curl", "-s", "-H", f"api_access_token: {CW_TOKEN}",
         f"{CW_BASE}{path}"],
        capture_output=True, text=True
    )
    return json.loads(r.stdout) if r.stdout.strip() else {}


def cw_put(path, data):
    r = subprocess.run(
        ["curl", "-s", "-X", "PUT",
         "-H", f"api_access_token: {CW_TOKEN}",
         "-H", "Content-Type: application/json",
         "-d", json.dumps(data),
         f"{CW_BASE}{path}"],
        capture_output=True, text=True
    )
    return json.loads(r.stdout) if r.stdout.strip() else {}


def cw_delete(path):
    r = subprocess.run(
        ["curl", "-s", "-X", "DELETE",
         "-H", f"api_access_token: {CW_TOKEN}",
         f"{CW_BASE}{path}"],
        capture_output=True, text=True
    )
    return r.returncode == 0


# 1. Carregar TODOS os contatos do Chatwoot
print("Carregando todos os contatos do Chatwoot...")
todos_cw = []
page = 1
while True:
    data = cw_get(f"/contacts?page={page}")
    payload = data.get("payload", [])
    if not payload:
        break
    todos_cw.extend(payload)
    page += 1
    if page > 100:
        break

print(f"  {len(todos_cw)} contatos total")

# 2. Indexar TODOS contatos por telefone normalizado (só dígitos)
por_telefone = {}  # dígitos → contato
for c in todos_cw:
    phone = (c.get("phone_number") or "").strip()
    if phone:
        digits = normalizar(phone)
        if digits:
            por_telefone[digits] = c

print(f"  {len(por_telefone)} contatos com telefone indexados")

# 3. Identificar contatos sem nome (JID) que têm par E.164
sem_nome = []
for c in todos_cw:
    name = (c.get("name") or "").strip()
    phone = (c.get("phone_number") or "").strip()
    if phone and (not name or phone_re.match(name)):
        sem_nome.append(c)

print(f"  {len(sem_nome)} contatos sem nome real")

# 4. Para cada sem-nome, procurar par E.164 no Chatwoot
merges = []      # JID absorvido pelo E.164
rename_only = [] # sem par E.164 → só renomear
nao_encontrados = []

# Exportar leads do CRM para busca de nomes
print("\nExportando leads do CRM...")
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

crm_by_last8 = {}
for lead in all_leads:
    fn = (lead.get("firstName") or "").strip()
    ln = (lead.get("lastName") or "").strip()
    name = f"{fn} {ln}".strip()
    phone = normalizar(lead.get("phoneNumber", ""))
    if phone and name and len(phone) >= 8:
        suffix = phone[-8:]
        if suffix not in crm_by_last8:
            crm_by_last8[suffix] = name

print(f"  {len(all_leads)} leads, {len(crm_by_last8)} indexados")

print("\nAnalisando duplicatas...")
for c in sem_nome:
    cw_phone_raw = (c.get("phone_number") or "").strip()
    cw_digits = normalizar(cw_phone_raw)
    cw_id = c["id"]

    # Calcular telefone E.164 (com 9° dígito)
    e164_digits = normalizar_e164(cw_digits)

    # Se o telefone mudou (tinha 12 → 13 dígitos), procurar par E.164
    if e164_digits != cw_digits and e164_digits in por_telefone:
        par = por_telefone[e164_digits]
        par_name = (par.get("name") or "").strip()
        merges.append({
            "jid_id": cw_id,
            "jid_phone": cw_phone_raw,
            "jid_name": c.get("name", ""),
            "e164_id": par["id"],
            "e164_phone": par.get("phone_number", ""),
            "e164_name": par_name,
        })
    else:
        # Sem par E.164 — tentar renomear via CRM
        crm_name = None
        if len(cw_digits) >= 8:
            suffix = cw_digits[-8:]
            crm_name = crm_by_last8.get(suffix)

        if crm_name:
            rename_only.append({
                "cw_id": cw_id,
                "phone": cw_phone_raw,
                "old_name": c.get("name", ""),
                "new_name": crm_name,
            })
        else:
            nao_encontrados.append({
                "cw_id": cw_id,
                "phone": cw_phone_raw,
                "name": c.get("name", ""),
            })

# 5. Relatório
print(f"\n{'='*70}")
print(f"MERGES — JID absorvido pelo E.164 ({len(merges)}):")
print(f"{'='*70}")
for m in merges:
    print(f"  APAGAR  id={m['jid_id']}  {m['jid_phone']}  \"{m['jid_name']}\"")
    print(f"  MANTER  id={m['e164_id']}  {m['e164_phone']}  \"{m['e164_name']}\"")
    print()

if rename_only:
    print(f"RENOMEAR ({len(rename_only)}):")
    for item in rename_only:
        print(f"  id={item['cw_id']}  {item['phone']}  \"{item['old_name']}\" → \"{item['new_name']}\"")

if nao_encontrados:
    print(f"\nNÃO ENCONTRADOS ({len(nao_encontrados)}):")
    for item in nao_encontrados:
        print(f"  id={item['cw_id']}  {item['phone']}  \"{item['name']}\"")

print(f"\n--- RESUMO ---")
print(f"  Merges (apagar JID):  {len(merges)}")
print(f"  Renomear:             {len(rename_only)}")
print(f"  Sem solução:          {len(nao_encontrados)}")

total_acoes = len(merges) + len(rename_only)
if total_acoes == 0:
    print("\nNada a fazer!")
    sys.exit(0)

if not apply_mode:
    print(f"\n--- DRY RUN --- rode com --apply para executar")
    sys.exit(0)

# 6. Aplicar
print(f"\n--- APLICANDO ---")
ok_del = err_del = ok_ren = err_ren = 0

for m in merges:
    try:
        # Apagar o contato JID (o E.164 já existe com nome correto)
        cw_delete(f"/contacts/{m['jid_id']}")
        print(f"  OK APAGADO id={m['jid_id']}  {m['jid_phone']}  (E.164: id={m['e164_id']})")
        ok_del += 1
    except Exception as e:
        print(f"  ERRO apagando id={m['jid_id']}: {e}")
        err_del += 1

for item in rename_only:
    try:
        result = cw_put(f"/contacts/{item['cw_id']}", {"name": item["new_name"]})
        if result.get("id"):
            print(f"  OK RENOMEADO id={item['cw_id']}  \"{item['new_name']}\"")
            ok_ren += 1
        else:
            print(f"  ERRO id={item['cw_id']}: {json.dumps(result)[:100]}")
            err_ren += 1
    except Exception as e:
        print(f"  ERRO renomeando id={item['cw_id']}: {e}")
        err_ren += 1

print(f"\nResultado: {ok_del} apagados, {ok_ren} renomeados, {err_del + err_ren} erros")
