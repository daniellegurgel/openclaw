#!/usr/bin/env python3
"""Testa busca no EspoCRM para os telefones sem nome no Chatwoot."""
import json, subprocess

ESPO_AUTH = "admin:Usp@19782026"
ESPO_BASE = "https://crm.neurotrading.com.br/api/v1"

phones = [
    "5511957946709", "557191825967", "553597550754", "556798776032",
    "558486340456", "551431200245", "553186962342", "557399130102",
]

for ph in phones:
    found = False
    for entity in ["Lead", "Contact"]:
        # Tentar busca completa
        url = (
            f"{ESPO_BASE}/{entity}"
            f"?where[0][type]=contains&where[0][attribute]=phoneNumber"
            f"&where[0][value]={ph}&select=firstName,lastName,phoneNumber&maxSize=3"
        )
        r = subprocess.run(
            ["curl", "-s", "-u", ESPO_AUTH, url],
            capture_output=True, text=True
        )
        try:
            data = json.loads(r.stdout)
            total = data.get("total", 0)
            if total > 0:
                item = data["list"][0]
                fn = item.get("firstName", "")
                ln = item.get("lastName", "")
                pn = item.get("phoneNumber", "")
                print(f"  {ph} -> {entity}: FOUND  name='{fn} {ln}'  phone='{pn}'")
                found = True
                break
        except:
            print(f"  {ph} -> {entity}: PARSE ERROR  stdout={r.stdout[:80]}")

    if not found:
        # Tentar últimos 8 dígitos
        short = ph[-8:]
        for entity in ["Lead", "Contact"]:
            url = (
                f"{ESPO_BASE}/{entity}"
                f"?where[0][type]=contains&where[0][attribute]=phoneNumber"
                f"&where[0][value]={short}&select=firstName,lastName,phoneNumber&maxSize=3"
            )
            r = subprocess.run(
                ["curl", "-s", "-u", ESPO_AUTH, url],
                capture_output=True, text=True
            )
            try:
                data = json.loads(r.stdout)
                total = data.get("total", 0)
                if total > 0:
                    item = data["list"][0]
                    fn = item.get("firstName", "")
                    ln = item.get("lastName", "")
                    pn = item.get("phoneNumber", "")
                    print(f"  {ph} -> {entity} (last8): FOUND  name='{fn} {ln}'  phone='{pn}'")
                    found = True
                    break
            except:
                pass
        if not found:
            print(f"  {ph} -> NOT FOUND (full + last8)")

# Verificar quantos leads/contacts existem no total
for entity in ["Lead", "Contact"]:
    url = f"{ESPO_BASE}/{entity}?select=id&maxSize=1"
    r = subprocess.run(
        ["curl", "-s", "-u", ESPO_AUTH, url],
        capture_output=True, text=True
    )
    try:
        data = json.loads(r.stdout)
        print(f"\n{entity} total: {data.get('total', '?')}")
    except:
        print(f"\n{entity}: parse error")
