#!/usr/bin/env python3
"""Conta leads no EspoCRM com e sem telefone."""
import subprocess, json, urllib.parse

AUTH = "admin:Usp@19782026"
BASE = "https://crm.neurotrading.com.br/api/v1"

for label, wtype in [("COM telefone", "isNotNull"), ("SEM telefone", "isNull")]:
    params = urllib.parse.urlencode({
        "where[0][type]": wtype,
        "where[0][attribute]": "phoneNumber",
        "select": "id",
        "maxSize": "1",
    })
    url = BASE + "/Lead?" + params
    r = subprocess.run(["curl", "-s", "-u", AUTH, url], capture_output=True, text=True)
    data = json.loads(r.stdout)
    total = data.get("total", "?")
    print(f"  {label}: {total} leads")
