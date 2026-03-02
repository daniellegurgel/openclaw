#!/usr/bin/env python3
"""Verifica contatos sem nome no Chatwoot. Danielle Gurgel, 2026-02-25"""
import json, subprocess

ALL_CONTACTS = []
page = 1
while True:
    r = subprocess.run(
        ["curl", "-s", "-H", "api_access_token: 5gW1D4xtWRVauCPGvHs9fPVr",
         f"http://localhost:3000/api/v1/accounts/1/contacts?page={page}&sort=created_at"],
        capture_output=True, text=True
    )
    data = json.loads(r.stdout)
    payload = data.get("payload", [])
    if not payload:
        break
    ALL_CONTACTS.extend(payload)
    page += 1
    if page > 50:
        break

sem_nome = []
com_nome = []
for c in ALL_CONTACTS:
    name = (c.get("name") or "").strip()
    if not name or name.startswith("+"):
        sem_nome.append(c)
    else:
        com_nome.append(c)

print(f"Total: {len(ALL_CONTACTS)} contatos")
print(f"Com nome: {len(com_nome)}")
print(f"Sem nome (vazio ou só telefone): {len(sem_nome)}")
print()
print("--- Contatos SEM NOME ---")
for c in sem_nome:
    cid = c["id"]
    name = c.get("name", "")
    phone = c.get("phone_number", "")
    email = c.get("email", "")
    print(f"  id={cid}  name='{name}'  phone={phone}  email={email}")
