#!/usr/bin/env python3
"""Debug: testar formatos de busca no EspoCRM."""
import subprocess, json, urllib.parse

ESPO_AUTH = "admin:Usp@19782026"

# Telefone que sabemos existir: Chantal +5531992035191
# E um dos 35: +5511957946709
test_phones = [
    ("Chantal (existe)", "5531992035191"),
    ("sem-nome-1", "5511957946709"),
    ("sem-nome-2", "557191825967"),
    ("sem-nome-3", "553597550754"),
]

for label, digits in test_phones:
    print(f"\n{label} ({digits}):")
    searches = [
        ("full", digits),
        ("last11", digits[-11:]),
        ("last9", digits[-9:]),
        ("last8", digits[-8:]),
    ]
    for slabel, val in searches:
        params = urllib.parse.urlencode({
            "where[0][type]": "contains",
            "where[0][attribute]": "phoneNumber",
            "where[0][value]": val,
            "select": "firstName,lastName,phoneNumber",
            "maxSize": "3",
        })
        url = f"https://crm.neurotrading.com.br/api/v1/Lead?{params}"
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
                print(f"  [{slabel}] val={val} -> FOUND: {fn} {ln} (phone={pn})")
            else:
                print(f"  [{slabel}] val={val} -> 0 results")
        except Exception as e:
            print(f"  [{slabel}] val={val} -> ERROR: {e}, stdout={r.stdout[:60]}")
