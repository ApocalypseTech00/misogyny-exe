# Crossmint Card Payments Setup — MISOGYNY.EXE

## What it does
Crossmint adds a "Pay with Card" button to the landing page. Visitors scan a QR code, land on the site, and can buy the open edition NFT with a credit/debit card — no wallet or crypto needed. Crossmint handles fiat-to-crypto conversion and mints on their behalf.

## Setup Steps

### 1. Create Crossmint Account
- Go to https://www.crossmint.com/console
- Use **burner email + VPN** (see SECURITY.md)
- Create a new project

### 2. Register Your Collection
In the Crossmint console:
- **Chain**: Base (mainnet) or Base Sepolia (testnet)
- **Contract address**: Your ERC-721 contract address (MisogynyNFT on Base)
- **Token standard**: ERC-721
- **Mint function**: Configure in Crossmint for your contract's mint function
- **Price**: 0.002 ETH
- **Token ID**: The token ID of your open edition (usually `1`)

### 3. Get Your Client ID
- In the Crossmint console, go to API Keys
- Copy your **Client-side API key** (safe for frontend)
- This is the `clientId` used in the pay button

### 4. Update the Landing Page
In `site/index.html`, replace `YOUR_CROSSMINT_CLIENT_ID` with your actual client ID.

### 5. Test First!
- Use `environment="staging"` for testing
- Test on Base Sepolia before switching to mainnet
- Verify the mint actually goes through and funds route to PaymentSplitter

## Fees
- Crossmint charges ~3-5% on card payments (payment processing + platform fee)
- This is on top of the mint price — the buyer pays slightly more
- All proceeds route through the marketplace to PaymentSplitter

## Docs
- https://docs.crossmint.com/payments/checkout/embedded
- https://www.crossmint.com/console
