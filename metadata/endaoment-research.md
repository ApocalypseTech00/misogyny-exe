# Endaoment Research — MISOGYNY.EXE

## Status: RESOLVED — Using off-ramp to Refuge instead

After extensive research, we determined that UK domestic violence charities (Refuge, Women's Aid) are not available on Endaoment, and no suitable Endaoment entities are deployed on Base chain. The project will use a dedicated charity wallet in the PaymentSplitter, with an automated off-ramp pipeline to convert ETH to GBP and bank transfer to Refuge.

---

## Why not Endaoment?

- Endaoment only supports US 501(c)(3) nonprofits
- Refuge (UK charity #277424) and Women's Aid (UK charity #1054154) are UK-registered, not US tax-exempt
- Some UK charities exist in Endaoment's database (Leeds Women's Aid, Latin American Women's Aid) but their entity contracts are NOT deployed on Base
- The Endaoment OrgFundFactory exists on Base but deploying untested entities is risky
- GiveDirectly was considered but dilutes the project's DV focus

## Charities verified NOT on Base via Endaoment

| Charity | Endaoment Status | Base Deployed? |
|---------|-----------------|----------------|
| Refuge | Not listed | N/A |
| Women's Aid | Not listed | N/A |
| Leeds Women's Aid | Listed, no EIN | No |
| Latin American Women's Aid | Listed, no EIN | No |
| National DV Hotline (US) | Listed, EIN 751658287 | Yes - but US charity |
| GiveDirectly | Listed, deployed on Base | Not DV-specific |

## Final Architecture

```
Zora mint → PaymentSplitter (50%) → Charity wallet (0x092CCA9...)
                                          ↓
                               Coinbase auto-convert ETH → GBP
                                          ↓
                               Bank transfer to Refuge
```

- On-chain split: fully automated, verifiable
- Off-ramp: automated via Coinbase API + cron script on Hetzner
- Bank transfer: triggered when balance exceeds threshold
- Proof of transfers posted publicly

## Contract Addresses Checked

- Endaoment Registry (Base): `0x237b53bcfbd3a114b549dfec96a9856808f45c94`
- Endaoment OrgFundFactory (Base): `0x10fd9348136dcea154f752fe0b6db45fc298a589`
- National DV Hotline (Base): `0x03a5d1439bc793dc564d2e72805129a1d5c522a3` — confirmed deployed but US-only
