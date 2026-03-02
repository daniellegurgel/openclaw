#!/usr/bin/env python3
"""Testa busca por telefone no EspoCRM com diferentes formatos."""
import json, subprocess

phone = "+556798776032"

searches = [
    ("completo", phone),
    ("sem +", phone.lstrip("+")),
    ("sem +55", phone[3:]),
    ("ultimos 11", phone[-11:]),
    ("ultimos 10", phone[-10:]),
    ("ultimos 9", phone[-9:]),
    ("ultimos 8", phone[-8:]),
]

for label, s in searches:
    url = (
        f"https://crm.neurotrading.com.br/api/v1/Lead"
        f"?where[0][type]=contains&where[0][attribute]=phoneNumber"
        f"&where[0][value]={s}&select=firstName,lastName,phoneNumber&maxSize=3"
    )
    r = subprocess.run(
        ["curl", "-s", "-u", "admin:Usp@19782026", url],
        capture_output=True, text=True
    )
    if not r.stdout.strip():
        print(f"  [{label}] busca=\"{s}\" -> resposta vazia")
        continue
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        print(f"  [{label}] busca=\"{s}\" -> JSON invalido: {r.stdout[:80]}")
        continue
    total = data.get("total", 0)
    if total > 0:
        lead = data["list"][0]
        name = f"{lead.get('firstName','')} {lead.get('lastName','')}".strip()
        ph = lead.get("phoneNumber", "")
        print(f"  [{label}] busca=\"{s}\" -> ACHOU: {name} (phone={ph})")
    else:
        print(f"  [{label}] busca=\"{s}\" -> nada (total=0)")
